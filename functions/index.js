// firebase use
// firebase functions:shell
// firebase deploy --only functions:ratingAdded
// ./functions/node_modules/eslint/bin/eslint.js functions --fix

const functions = require("firebase-functions");
const algosdk = require("algosdk");
// algosdk.algosToMicroalgos(1);

const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();

// const clientMAINNET = algosdk.Algodv2(
//     "",
//     "https://algoexplorerapi.io",
//     "",
// );
const clientTESTNET = new algosdk.Algodv2(
    "",
    "https://testnet.algoexplorerapi.io",
    "",
);
const indexerTESTNET = new algosdk.Indexer(
    "",
    "https://algoindexer.testnet.algoexplorerapi.io",
    "",
);
const SYSTEM_ACCOUNT = "KTNEHVYFHJIWSTWZ7SQJSSA24JHTX3KXUABO64ZQTRCBFIM3EMCXVMBD6M";
const MIN_TXN_FEE = 1000;

const runWithObj = {minInstances: 0, memory: "128MB"};

exports.userCreated = functions.runWith(runWithObj).auth.user().onCreate((user) => {
  const docRefUser = db.collection("users").doc(user.uid);
  const createUserFuture = docRefUser.create({
    status: "ONLINE",
    meeting: null,
    bio: "",
    name: "",
    rating: 1,
    numRatings: 0,
    heartbeat: admin.firestore.FieldValue.serverTimestamp(),
    tags: [],
  });
  const createUserPrivateFuture = docRefUser.collection("private").doc("main").create({
    blocked: [],
    friends: [],
  });
  return Promise.all([createUserFuture, createUserPrivateFuture]);
});

exports.ratingAdded = functions.runWith(runWithObj).firestore
    .document("users/{userId}/ratings/{ratingId}")
    .onCreate((change, context) => {
      const meetingRating = change.get("rating");
      const userId = context.params.userId;
      return db.runTransaction(async (T) => {
        const docRefUser = db.collection("users").doc(userId);
        const docUser = await docRefUser.get();
        const numRatings = docUser.get("numRatings") ?? 0;
        const userRating = docUser.get("rating") ?? 1;
        const newNumRatings = numRatings + 1;
        const newRating = (userRating * numRatings + meetingRating) / newNumRatings; // works for numRatings == 0
        await docRefUser.update({
          rating: newRating,
          numRatings: newNumRatings,
        });
      });
    });

exports.meetingCreated = functions.runWith(runWithObj).firestore
    .document("meetings/{meetingId}")
    .onCreate(async (change, context) => {
      const meeting = change.data();
      const A = meeting.A;
      const B = meeting.B;
      const bid = meeting.bid;
      const obj = {active: false};
      const bidOutRef = db.collection("users").doc(A).collection("bidOuts").doc(bid);
      const bidInRef = db.collection("users").doc(B).collection("bidIns").doc(bid);
      return db.runTransaction(async (T) => {
        T.update(bidOutRef, obj);
        T.update(bidInRef, obj);
      });
    });
exports.meetingUpdated = functions.runWith(runWithObj).firestore
    .document("meetings/{meetingId}")
    .onUpdate(async (change, context) => {
      const oldMeeting = change.before.data();
      const newMeeting = change.after.data();

      // has status changed?
      console.log("meetingUpdated, oldMeeting.status, newMeeting.status", oldMeeting.status, newMeeting.status);
      if (oldMeeting.status === newMeeting.status) return 0;

      if ((newMeeting.status === "RECEIVED_REMOTE_A" && oldMeeting.status == "RECEIVED_REMOTE_B") ||
           newMeeting.status === "RECEIVED_REMOTE_B" && oldMeeting.status == "RECEIVED_REMOTE_A") {
        return change.after.ref.update({
          start: admin.firestore.FieldValue.serverTimestamp(),
          status: "CALL_STARTED",
          statusHistory: admin.firestore.FieldValue.arrayUnion({
            value: "CALL_STARTED",
            ts: admin.firestore.Timestamp.now(),
          }),
        });
      }

      // is meeting done?
      console.log("meetingUpdated, newMeeting.status", newMeeting.status);
      if (!newMeeting.status.startsWith("END_")) return 0;

      // unlock users
      if (newMeeting.status === "END_DISCONNECT") {
        const colRef = db.collection("users");
        const A = newMeeting.A;
        const B = newMeeting.B;
        const docRefA = colRef.doc(A);
        const docRefB = colRef.doc(B);
        const unlockAPromise = docRefA.update({meeting: null});
        const unlockBPromise = docRefB.update({meeting: null});
        await Promise.all([unlockAPromise, unlockBPromise]);
        console.log("meetingUpdated, users unlocked");
      }

      newMeeting.duration = newMeeting.start ? newMeeting.end.seconds - newMeeting.start.seconds : 0;

      return settleMeeting(change.after.ref, newMeeting);
    });

const settleMeeting = async (docRef, meeting) => {
  console.log("settleMeeting, meeting", meeting);

  let txIds = null;
  if (meeting.speed.num !== 0) {
    if (meeting.speed.assetId === 0) {
      txIds = await settleALGOMeeting(clientTESTNET, meeting);
    } else {
      // txId = await settleASAMeeting(clientTESTNET, meeting);
      throw Error("no ASA at the moment");
    }
  }

  console.log("settleMeeting, txIds", txIds);

  // update meeting
  return docRef.update({
    "txns.unlock": txIds,
    "settled": true,
    "duration": meeting.duration,
  });
};

const settleALGOMeeting = async (
    algodclient,
    meeting,
) => {
  const note = Buffer.from(meeting.bid + "." + meeting.speed.num + "." + meeting.speed.assetId).toString("base64");
  const lookup = await indexerTESTNET.lookupAccountTransactions(SYSTEM_ACCOUNT).txType("pay").assetID(0).notePrefix(note).minRound(19000000).do();
  console.log("lookup", lookup, lookup.transactions.length);

  if (lookup.transactions.length !== 1) return; // there should exactly one lock txn for this bid
  const txn = lookup.transactions[0];
  const sender = txn.sender;
  console.log("sender", sender, meeting.A, sender !== meeting.addrA);
  if (sender !== meeting.addrA) return; // pay back to same account only
  const paymentTxn = txn["payment-transaction"];
  const receiver = paymentTxn.receiver;
  console.log("receiver", receiver, receiver !== SYSTEM_ACCOUNT);
  if (receiver !== SYSTEM_ACCOUNT) return;

  const maxEnergy = paymentTxn.amount - 2 * MIN_TXN_FEE;
  console.log("maxEnergy", maxEnergy);

  const energy = Math.min(meeting.duration * meeting.speed.num, maxEnergy);
  console.log("energy", energy);

  const energyA = maxEnergy - energy + (energy === 0 ? MIN_TXN_FEE : 0);
  console.log("energyA", energyA);
  const energyB = Math.ceil(0.9 * energy);
  console.log("energyB", energyB);

  const accountCreator = algosdk.mnemonicToSecretKey(process.env.SYSTEM_PK);
  const ps = [];
  if (energyA !== 0) {
    const p = sendALGO(algodclient, accountCreator, {addr: meeting.addrA}, energyA);
    ps.push(p);
  }
  if (energyB !== 0) {
    const p = sendALGO(algodclient, accountCreator, {addr: meeting.addrB}, energyB);
    ps.push(p);
  }

  return Promise.all(ps);
};

// every minute
exports.checkUserStatus = functions.runWith(runWithObj).pubsub.schedule("* * * * *").onRun(async (context) => {
  console.log("context", context);
  const T = new Date();
  T.setSeconds(T.getSeconds() - 10);
  const usersColRef = db.collection("users");
  const queryRef = usersColRef.where("status", "==", "ONLINE").where("heartbeat", "<", T);
  const querySnapshot = await queryRef.get();
  console.log("querySnapshot.size", querySnapshot.size);
  const promises = [];
  querySnapshot.forEach(async (queryDocSnapshotUser) => {
    console.log("queryDocSnapshotUser.id", queryDocSnapshotUser.id);
    const p = queryDocSnapshotUser.ref.update({status: "OFFLINE"});
    promises.push(p);
    const meeting = queryDocSnapshotUser.get("meeting");
    console.log("meeting", meeting);
    if (meeting) {
      const meetingObj = {
        status: "END_DISCONNECT",
        statusHistory: admin.firestore.FieldValue.arrayUnion({value: "END_DISCONNECT", ts: admin.firestore.Timestamp.now()}),
        isActive: false,
        end: admin.firestore.FieldValue.serverTimestamp(),
      };
      const meetingDocRef = db.collection("meetings").doc(meeting);
      const meetingPromise = meetingDocRef.update(meetingObj);
      promises.push(meetingPromise);
    }
  });
  await Promise.all(promises);
});

exports.topDurationMeetings = functions.runWith(runWithObj).https.onCall(async (data, context) => {
  // context.app will be undefined if the request doesn't include a valid
  // App Check token.
  if (context.app == undefined) {
    throw new functions.https.HttpsError(
        "failed-precondition",
        "The function must be called from an App Check verified app.");
  }
  const uid = context.auth.uid;
  if (!uid) return;

  return topMeetings("duration");
});
exports.topSpeedMeetings = functions.runWith(runWithObj).https.onCall(async (data, context) => {
  // context.app will be undefined if the request doesn't include a valid
  // App Check token.
  if (context.app == undefined) {
    throw new functions.https.HttpsError(
        "failed-precondition",
        "The function must be called from an App Check verified app.");
  }
  const uid = context.auth.uid;
  if (!uid) return;

  return topMeetings("speed.num");
});
const topMeetings = async (order) => {
  const querySnapshot = await db
      .collection("meetings")
      .where("isSettled", "==", true)
      .select("B", "duration", "speed")
      .where("speed.assetId", "==", 0)
      .orderBy(order, "desc")
      .limit(10)
      .get();


  const topMeetings = querySnapshot.docs.map((doc) => {
    const data = doc.data();
    const B = data.B;
    const duration = data.duration;
    const speed = data.speed;
    return {
      id: doc.id,
      B: B,
      duration: duration,
      speed: speed,
    };
  });

  const futures = topMeetings.map((topMeeting) => {
    return db.collection("users").doc(topMeeting.B).get().then((user) => {
      topMeeting.name = user.get("name");
      return topMeeting;
    });
  });

  return Promise.all(futures);
};

const sendALGO = async (client, fromAccount, toAccount, amount) => {
  // txn
  const suggestedParams = await client.getTransactionParams().do();
  // const note = new Uint8Array(Buffer.from('', 'utf8'));
  const transactionOptions = {
    from: fromAccount.addr,
    to: toAccount.addr,
    amount,
    // note,
    suggestedParams,
  };
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject(
      transactionOptions,
  );

  // sign
  const signedTxn = txn.signTxn(fromAccount.sk);

  // send raw
  const {txId} = await client.sendRawTransaction(signedTxn).do();
  console.log("txId");
  console.log(txId);

  return txId;
};

// exports.test = functions.runWith(runWithObj).https.onCall(async (data, context) => {
// });

// const NOVALUE_ASSET_ID = 29147319;

// exports.giftALGO = functions.runWith(runWithObj).https.onCall(async (data, context) => {
//   if (context.app == undefined) {
//     throw new functions.https.HttpsError(
//         "failed-precondition",
//         "The function must be called from an App Check verified app.");
//   }
//   const uid = context.auth.uid;
//   if (!uid) return;

//   const creatorAccount = algosdk.mnemonicToSecretKey(process.env.SYSTEM_PK);
//   console.log("creatorAccount.addr", creatorAccount.addr);

//   const userAccount = {addr: data.account};
//   console.log("data.account", data.account);

//   return sendALGO(clientTESTNET,
//       creatorAccount,
//       userAccount,
//       1000000);
// });

// exports.giftASA = functions.runWith({minInstances: MIN_INSTANCES}).https.onCall(async (data, context) => {
//   const creatorAccount = algosdk.mnemonicToSecretKey(CREATOR_PRIVATE_KEY);
//   console.log("creatorAccount.addr", creatorAccount.addr);

//   const userAccount = {addr: data.account};
//   console.log("data.account", data.account);

//   return sendASA(clientTESTNET,
//       creatorAccount,
//       userAccount,
//       1000,
//       NOVALUE_ASSET_ID);
// });

// const waitForConfirmation = async (algodclient, txId, timeout) => {
//   if (algodclient == null || txId == null || timeout < 0) {
//     throw new Error("Bad arguments.");
//   }
//   const status = await algodclient.status().do();
//   if (typeof status === "undefined") {
//     throw new Error("Unable to get node status");
//   }
//   const startround = status["last-round"] + 1;
//   let currentround = startround;

//   /* eslint-disable no-await-in-loop */
//   while (currentround < startround + timeout) {
//     const pendingInfo = await algodclient
//         .pendingTransactionInformation(txId)
//         .do();
//     if (pendingInfo !== undefined) {
//       if (
//         pendingInfo["confirmed-round"] !== null &&
//         pendingInfo["confirmed-round"] > 0
//       ) {
//         // Got the completed Transaction
//         return pendingInfo;
//       }

//       if (
//         pendingInfo["pool-error"] != null &&
//         pendingInfo["pool-error"].length > 0
//       ) {
//         // If there was a pool error, then the transaction has been rejected!
//         throw new Error(
//             `Transaction Rejected pool error${pendingInfo["pool-error"]}`,
//         );
//       }
//     }
//     await algodclient.statusAfterBlock(currentround).do();
//     currentround += 1;
//   }
//   /* eslint-enable no-await-in-loop */
//   throw new Error(`Transaction not confirmed after ${timeout} rounds!`);
// };

// const optIn = async (client, account, assetIndex) =>
//   sendASA(client, account, account, 0, assetIndex);

// const sendASA = async (client, fromAccount, toAccount, amount, assetIndex) => {
//   // txn
//   const suggestedParams = await client.getTransactionParams().do();
//   const transactionOptions = {
//     from: fromAccount.addr,
//     to: toAccount.addr,
//     assetIndex,
//     amount,
//     suggestedParams,
//   };
//   const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject(
//       transactionOptions,
//   );

//   // sign
//   const signedTxn = txn.signTxn(fromAccount.sk);

//   // send raw
//   const {txId} = await client.sendRawTransaction(signedTxn).do();
//   console.log("txId");
//   console.log(txId);

//   return txId;
// };

// const settleASAMeeting = async (
//     algodclient,
//     meeting,
// ) => {
//   console.log("settleASAMeeting, meeting", meeting);

//   // accounts
//   const accountCreator = algosdk.mnemonicToSecretKey(process.env.SYSTEM_PK);
//   console.log("settleASAMeeting, accountCreator.addr", accountCreator.addr);
//   const suggestedParams = await algodclient.getTransactionParams().do();
//   console.log("settleASAMeeting, suggestedParams", suggestedParams);

//   // state
//   const appArg0 = new TextEncoder().encode("UNLOCK");
//   const appArg1 = algosdk.encodeUint64(meeting.duration);
//   const appArgs = [appArg0, appArg1];
//   const stateTxn = algosdk.makeApplicationNoOpTxnFromObject({
//     from: accountCreator.addr,
//     appIndex: SYSTEM_ID,
//     appArgs,
//     accounts: [meeting.addrA, meeting.addrB],
//     foreignAssets: [meeting.speed.assetId],
//     suggestedParams,
//   });
//   console.log("settleASAMeeting, stateTxn");

//   // sign
//   const stateTxnSigned = stateTxn.signTxn(accountCreator.sk);
//   console.log("settleASAMeeting, signed");

//   // send
//   try {
//     const {txId} = await algodclient.sendRawTransaction([stateTxnSigned]).do();
//     console.log("settleASAMeeting, sent", txId);

//     // confirm
//     const timeout = 5;
//     await waitForConfirmation(algodclient, txId, timeout);
//     console.log("settleASAMeeting, confirmed");

//     return txId;
//   } catch (e) {
//     console.log("error", e);
//     throw Error(e);
//   }
// };

// ONLY USE MANUALLY
// deleteAllAuthUsers({})
// exports.deleteAllAuthUsers = functions.https.onCall(async (data, context) => {
//   const users = await admin.auth().listUsers();
//   return admin.auth().deleteUsers(users.users.map(u => u.uid));
// });

// optInToASA({txId: 'QO47JEGJXGRLUKVQ44CKZXQ2X3C4R3JFT22GCUFABNVIC33BZ4AQ', assetId: 23828034})
// exports.optInToASA = functions.runWith({minInstances: MIN_INSTANCES}).https.onCall(async (data, context) => {
//   console.log("optInToASA, data", data);
//   await waitForConfirmation(clientTESTNET, data.txId, 5);
//   console.log("optInToASA, waitForConfirmation done");

//   const accountCreator = algosdk.mnemonicToSecretKey(CREATOR_PRIVATE_KEY);

//   // txn confirmed
//   const suggestedParams = await clientTESTNET.getTransactionParams().do();
//   const optInTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject(
//       {
//         from: accountCreator.addr,
//         to: accountCreator.addr,
//         assetIndex: data.assetId,
//         amount: 0,
//         suggestedParams,
//       },
//   );

//   // sign
//   const optInTxnSigned = optInTxn.signTxn(accountCreator.sk);
//   console.log("optInToASA, signed");

//   // send
//   try {
//     const {txId} = await clientTESTNET.sendRawTransaction([optInTxnSigned]).do();
//     console.log("optInToASA, sent", txId);

//     // confirm
//     const timeout = 5;
//     await waitForConfirmation(clientTESTNET, txId, timeout);
//     console.log("optInToASA, end waitForConfirmation done");

//     return txId;
//   } catch (e) {
//     console.log("error", e);
//     throw Error(e);
//   }
// });

// MIGRATION

// exports.addHeartbeat = functions.https.onCall(async (data, context) => {
//   const usersColRef = db.collection("users");
//   const querySnapshot = await usersColRef.get();
//   for (const queryDocSnapshot of querySnapshot.docs) {
//     const heartbeat = queryDocSnapshot.get("heartbeat");
//     if (heartbeat) continue;
//     await queryDocSnapshot.ref.update({"heartbeat": 0});
//   }
// });

// TEST

// test({meetingId: '9IHLdjOw9eHB0QEkpgYB'})
// exports.test = functions.https.onCall(async (data, context) => {
//   const meeting = {bid: 'TqY95mhcNCEEVW9q0eIQ', duration: 13, speed: {num: 1, assetId: 0}, addrA: 'V7MRVBP4VI6KJAL2URUZBN3TY5MZIJ7HMJINSFICSFSRQCSVNIJW5LMPNQ', addrB: '2I2IXTP67KSNJ5FQXHUJP5WZBX2JTFYEBVTBYFF3UUJ3SQKXSZ3QHZNNPY'};
// });
