// firebase use
// firebase functions:shell
// firebase deploy --only functions:ratingAdded
// ./functions/node_modules/eslint/bin/eslint.js functions --fix

const functions = require("firebase-functions");
const algosdk = require("algosdk");

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

const runWithObj = {minInstances: 1, memory: "128MB"};

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
        const numRatings = docUser.numRatings ?? 0;
        console.log("numRatings", numRatings);
        const userRating = docUser.rating ?? 1;
        console.log("userRating", userRating);
        const newNumRatings = numRatings + 1;
        console.log("newNumRatings", newNumRatings);
        console.log("meetingRating", meetingRating);
        const newRating = (userRating * numRatings + meetingRating) / newNumRatings; // works for numRatings == 0
        console.log("newRating", newRating);
        await docRefUser.update({
          rating: newRating,
          numRatings: newNumRatings,
        });
      });
    });

const SYSTEM_ID = 32969536;

const waitForConfirmation = async (algodclient, txId, timeout) => {
  if (algodclient == null || txId == null || timeout < 0) {
    throw new Error("Bad arguments.");
  }
  const status = await algodclient.status().do();
  if (typeof status === "undefined") {
    throw new Error("Unable to get node status");
  }
  const startround = status["last-round"] + 1;
  let currentround = startround;

  /* eslint-disable no-await-in-loop */
  while (currentround < startround + timeout) {
    const pendingInfo = await algodclient
        .pendingTransactionInformation(txId)
        .do();
    if (pendingInfo !== undefined) {
      if (
        pendingInfo["confirmed-round"] !== null &&
        pendingInfo["confirmed-round"] > 0
      ) {
        // Got the completed Transaction
        return pendingInfo;
      }

      if (
        pendingInfo["pool-error"] != null &&
        pendingInfo["pool-error"].length > 0
      ) {
        // If there was a pool error, then the transaction has been rejected!
        throw new Error(
            `Transaction Rejected pool error${pendingInfo["pool-error"]}`,
        );
      }
    }
    await algodclient.statusAfterBlock(currentround).do();
    currentround += 1;
  }
  /* eslint-enable no-await-in-loop */
  throw new Error(`Transaction not confirmed after ${timeout} rounds!`);
};

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
      console.log("meetingUpdated, oldMeeting.status", oldMeeting.status);
      if (oldMeeting.status === newMeeting.status) return 0;

      if ((newMeeting.status === "A_RECEIVED_REMOTE" && oldMeeting.status == "B_RECEIVED_REMOTE") ||
           newMeeting.status === "B_RECEIVED_REMOTE" && oldMeeting.status == "A_RECEIVED_REMOTE") {
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

      const colRef = db.collection("users");
      const A = newMeeting.A;
      const B = newMeeting.B;
      const docRefA = colRef.doc(A);
      const docRefB = colRef.doc(B);
      const unlockAPromise = docRefA.update({meeting: null});
      const unlockBPromise = docRefB.update({meeting: null});
      await Promise.all([unlockAPromise, unlockBPromise]);

      // if meeting never started, nothing to settle
      if (newMeeting.start === null) {
        return 0;
      }
      const start = (new Date(newMeeting.start)).get.getTime();
      const end = (new Date(newMeeting.end)).getTime();
      newMeeting.duration = Math.round((end - start) / 1000);

      // were coins locked?
      if (newMeeting.budget === 0) {
        return change.after.ref.update({isSettled: true, duration: newMeeting.duration});
      }

      return settleMeeting(change.after.ref, newMeeting);
    });

const settleMeeting = async (docRef, meeting) => {
  console.log("settleMeeting, meeting", meeting);
  let txId = null;

  console.log("settleMeeting, meeting.speed.num", meeting.speed.num);
  if (meeting.speed.num !== 0) {
    if (meeting.speed.assetId === 0) {
      txId = await settleALGOMeeting(clientTESTNET, meeting);
    } else {
      // txId = await settleASAMeeting(clientTESTNET, meeting);
      throw Error("no ASA at the moment");
    }
  }

  console.log("settleMeeting, txId", txId);

  // update meeting
  return docRef.update({
    "txns.unlock": txId,
    "isSettled": true,
    "duration": meeting.duration,
  });
};

const settleALGOMeeting = async (
    algodclient,
    meeting,
) => {
  console.log("settleALGOMeeting, meeting", meeting);

  // accounts
  const accountCreator = algosdk.mnemonicToSecretKey(process.env.SYSTEM_PK);
  console.log("settleALGOMeeting, accountCreator.addr", accountCreator.addr);
  const suggestedParams = await algodclient.getTransactionParams().do();
  console.log("settleALGOMeeting, suggestedParams", suggestedParams);

  // state
  const appArg0 = new TextEncoder().encode("UNLOCK");
  const appArg1 = algosdk.encodeUint64(meeting.duration);
  const appArgs = [appArg0, appArg1];
  const stateTxn = algosdk.makeApplicationNoOpTxnFromObject({
    from: accountCreator.addr,
    appIndex: SYSTEM_ID,
    appArgs,
    accounts: [meeting.addrA, meeting.addrB],
    suggestedParams,
  });
  // console.log("stateTxn", stateTxn);
  console.log("settleALGOMeeting, stateTxn");

  // sign
  const stateTxnSigned = stateTxn.signTxn(accountCreator.sk);
  console.log("settleALGOMeeting, signed");

  // send
  try {
    const {txId} = await algodclient.sendRawTransaction([stateTxnSigned]).do();
    console.log("settleALGOMeeting, sent");

    // confirm
    const timeout = 5;
    await waitForConfirmation(algodclient, txId, timeout);
    console.log("settleALGOMeeting, confirmed");

    return txId;
  } catch (e) {
    console.log("error", e);
    throw Error(e);
  }
};

// every minute
exports.checkUserStatus = functions.pubsub.schedule("* * * * *").onRun(async (context) => {
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
      .where("speed.assetId", "==", 0)
      .select(["B", "duration", "speed"])
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

// const NOVALUE_ASSET_ID = 29147319;

// exports.giftALGO = functions.runWith({minInstances: MIN_INSTANCES}).https.onCall(async (data, context) => {
//   const creatorAccount = algosdk.mnemonicToSecretKey(CREATOR_PRIVATE_KEY);
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

// const sendALGO = async (client, fromAccount, toAccount, amount) => {
//   // txn
//   const suggestedParams = await client.getTransactionParams().do();
//   // const note = new Uint8Array(Buffer.from('', 'utf8'));
//   const transactionOptions = {
//     from: fromAccount.addr,
//     to: toAccount.addr,
//     amount,
//     // note,
//     suggestedParams,
//   };
//   const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject(
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
//   const now = Math.floor(new Date().getTime() / 1000);
//   const usersColRef = db.collection("users");
//   const queryRef = usersColRef.where("status", "==", "ONLINE").where("heartbeat", "<", now - 10);
//   const querySnapshot = await queryRef.get();
//   console.log('querySnapshot.size', querySnapshot.size);
//   const promises = [];
//   querySnapshot.forEach(async (queryDocSnapshotUser) => {
//     const p = goOffline(queryDocSnapshotUser);
//     promises.push(p);
//   });
//   await Promise.all(promises);
// });
