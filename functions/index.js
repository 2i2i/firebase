// main actions:
// createBid - A
// acceptBid - B
// acceptMeeting - A
// createRoom - A

// firebase use
// firebase functions:shell
// firebase deploy --only functions:giftALGO
// ./functions/node_modules/eslint/bin/eslint.js functions --fix
// firebase emulators:start

const functions = require("firebase-functions");
const algosdk = require("algosdk");
// algosdk.algosToMicroalgos(1);

const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

const algorandAlgod = new algosdk.Algodv2(
    "",
    process.env.ALGORAND_ALGOD,
    "",
);
const algorandIndexer = new algosdk.Indexer(
    "",
    process.env.ALGORAND_INDEXER,
    "",
);

const MIN_TXN_FEE = 1000;

const LOUNGE_DICT = {
  "chrony": 0,
  "highroller": 1,
  "eccentric": 2,
  "lurker": 3,
};
const MAX_LOUNGE_HISTORY = 10;

const runWithObj = {
  minInstances: 1, memory: "128MB",
};

exports.userCreated = functions.runWith(runWithObj).auth.user().onCreate((user) => {
  const docRefUser = db.collection("users").doc(user.uid);
  return docRefUser.create({
    status: "ONLINE",
    meeting: null,
    bio: "",
    name: "",
    rating: 1,
    numRatings: 0,
    heartbeat: admin.firestore.FieldValue.serverTimestamp(),
    tags: [],
    rule: {
      // set also in frontend (userModel)
      maxMeetingDuration: 300,
      minSpeed: 0,
      importance: {
        lurker: 0,
        chrony: 1,
        highroller: 4,
        eccentric: 0,
      },
    },
    loungeHistory: [],
    loungeHistoryIndex: -1,
    blocked: [],
    friends: [],
  });
});

exports.cancelBid = functions.runWith(runWithObj).https.onCall(async (data, context) => {
  const uid = context.auth.uid;
  const bidId = data.bidId;

  console.log("uid", uid);
  console.log("bidId", bidId);

  const docRefBidOut = db.collection("users").doc(uid).collection("bidOuts").doc(bidId);
  return db.runTransaction(async (T) => {
    const docBidOut = await T.get(docRefBidOut);
    const speed = docBidOut.get("speed");
    const addrA = docBidOut.get("addrA");
    const noteString = bidId + "." + speed.num + "." + speed.assetId;
    console.log("noteString", noteString);
    const note = Buffer.from(noteString).toString("base64");
    console.log("note", note);
    const lookup = await algorandIndexer.lookupAccountTransactions(process.env.ALGORAND_SYSTEM_ACCOUNT).txType("pay").assetID(0).notePrefix(note).minRound(19000000).do();
    console.log("lookup.transactions.length", lookup.transactions.length);

    if (lookup.transactions.length !== 1) return; // there should exactly one lock txn for this bid
    const txn = lookup.transactions[0];
    const sender = txn.sender;
    console.log("sender", sender, addrA, sender !== addrA);
    if (sender !== addrA) return; // pay back to same account only
    const paymentTxn = txn["payment-transaction"];
    const receiver = paymentTxn.receiver;
    console.log("receiver", receiver, receiver !== process.env.ALGORAND_SYSTEM_ACCOUNT);
    if (receiver !== process.env.ALGORAND_SYSTEM_ACCOUNT) return; // CAREFUL - if we ever change this, cancel would fail

    const energyA = paymentTxn.amount - 2 * MIN_TXN_FEE; // keep 2 fees
    const txId = await runUnlock(algorandAlgod, energyA, 0, 0, addrA, addrA);

    const B = docBidOut.get("B");
    console.log("B", B);
    const docRefBidIn = db.collection("users").doc(B).collection("bidInsPublic").doc(bidId);
    const docRefBidInPrivate = db.collection("users").doc(B).collection("bidInsPrivate").doc(bidId);
    T.update(docRefBidOut, {
      "active": false,
      "txns.cancel": txId,
    });
    T.update(docRefBidIn, {
      "active": false,
    });
    T.update(docRefBidInPrivate, {
      "active": false,
    });
  });
});

// https://imgur.com/Jwih3Ac
// https://imgur.com/QEzobjq
exports.bidAdded = functions.runWith(runWithObj).firestore
    .document("users/{userId}/bidInsPublic/{bidId}")
    .onCreate(async (change, context) => {
      const userId = context.params.userId;
      const docRefToken = db.collection("tokens").doc(userId);
      const docToken = await docRefToken.get();
      if (!docToken.exists) return; // no token

      const token = docToken.get("token");

      const message = {
        notification: {
          title: "2i2i",
          body: "Someone wants to meet you",
          image: process.env.NOTIFICATON_IMAGE,
        },
        webpush: {
          headers: {
            Urgency: "high",
          },
          fcm_options: {
            link: `https://${process.env.DOMAIN}/myHangout`,
          },
        },
        token: token,
      };

      // DEBUG
      return messaging.send(message)
          .then((response) => {
            // Response is a message ID string.
            console.log("Successfully sent message:", response);
          })
          .catch((error) => {
            console.log("Error sending message:", error);
          });
    });

// updateDevices({});
// exports.updateDevices = functions.runWith(runWithObj).https.onCall(async (data, context) => {

//   const colRef = db.collection("tokens");
//   const col = await colRef.get();
//   const tokens = col.docs.map(doc => doc.get("token"));

//   const message = {
//     notification: {
//       title: "2i2i",
//       body: "Update available - Please reload",
//     },
//     data: {
//       action: "update",
//     },
//     tokens: tokens,
//   };`

//   return messaging.sendMulticast(message)
//       .then((response) => {
//         // Response is a message ID string.
//         console.log("Successfully sent message:", response);
//       })
//       .catch((error) => {
//         console.log("Error sending message:", error);
//       });
// });

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

const notifyA = async (A) => {
  const docRefToken = db.collection("tokens").doc(A);
  const docToken = await docRefToken.get();
  console.log("notifyA", docToken);
  if (!docToken.exists) return; // no token

  const token = docToken.get("token");

  const message = {
    // "to": token,
    "notification": {
      title: "2i2i",
      body: "The Host is calling you",
    },
    // "mutable_content": true,
    // "content_available": true,
    // "content-available": true,
    // "priority": "high",
    "data": {
      title: "2i2i",
      body: "The Host is calling you",
      imageUrl: process.env.NOTIFICATON_IMAGE,
      type: "Call",
    },
    "webpush": {
      headers: {
        Urgency: "high",
      },
      fcm_options: {
        link: `https://${process.env.DOMAIN}`,
      },
    },
    "token": token,
  };

  // DEBUG
  console.log("notifyA send");
  return messaging.send(message)
      .then((response) => {
        // Response is a message ID string.
        console.log("Successfully sent message:", response);
      })
      .catch((error) => {
        console.log("Error sending message:", error);
      });
};
exports.meetingCreated = functions.runWith(runWithObj).firestore
    .document("meetings/{meetingId}")
    .onCreate(async (change, context) => {
      const meeting = change.data();

      // lounge history
      const p1 = db.runTransaction(async (T) => {
        const docRefB = db.collection("users").doc(meeting.B);
        const docB = await T.get(docRefB);
        const loungeHistory = docB.get("loungeHistory");
        const loungeHistoryIndexDB = docB.get("loungeHistoryIndex");
        const lounge = LOUNGE_DICT[meeting.lounge];
        const loungeHistoryIndex = (loungeHistoryIndexDB + 1) % MAX_LOUNGE_HISTORY;
        if (loungeHistory.length < MAX_LOUNGE_HISTORY) {
          loungeHistory.push(lounge);
        } else {
          loungeHistory[loungeHistoryIndex] = lounge;
        }
        T.update(docRefB, {
          loungeHistory: loungeHistory,
          loungeHistoryIndex: loungeHistoryIndex,
        });
        console.log("meetingUpdated, new loungeHistory");
      });

      const p2 = notifyA(meeting.A);

      return Promise.all([p1, p2]);
    });
exports.meetingUpdated = functions.runWith(runWithObj).firestore.document("meetings/{meetingId}").onUpdate(async (change, context) => {
  const oldMeeting = change.before.data();
  const newMeeting = change.after.data();

  // has status changed?
  console.log("meetingUpdated, oldMeeting.status, newMeeting.status", oldMeeting.status, newMeeting.status);
  if (oldMeeting.status === newMeeting.status) return 0;

  if ((newMeeting.status === "RECEIVED_REMOTE_A" && oldMeeting.status == "RECEIVED_REMOTE_B") ||
           newMeeting.status === "RECEIVED_REMOTE_B" && oldMeeting.status == "RECEIVED_REMOTE_A") {
    // start: earlier of RECEIVED_REMOTE_A/B
    let start = admin.firestore.FieldValue.serverTimestamp();
    for (const s of newMeeting.statusHistory) {
      if (s.value === "RECEIVED_REMOTE_A" || s.value === "RECEIVED_REMOTE_B") start = s.ts;
    }
    console.log("meetingUpdated, start", start);

    return change.after.ref.update({
      start: start,
      status: "CALL_STARTED",
      statusHistory: admin.firestore.FieldValue.arrayUnion({
        value: "CALL_STARTED",
        ts: start,
      }),
    });
  }

  // is meeting done?
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

  newMeeting.duration = newMeeting.start !== null ? newMeeting.end.seconds - newMeeting.start.seconds : 0;
  // console.log("meetingUpdated, newMeeting.duration", newMeeting.start, newMeeting.end.seconds, newMeeting.start.seconds, newMeeting.duration);

  return settleMeeting(change.after.ref, newMeeting);
});

const settleMeeting = async (docRef, meeting) => {
  console.log("settleMeeting, meeting", meeting);

  let result = null;
  if (meeting.speed.num !== 0) {
    if (meeting.speed.assetId === 0) {
      result = await settleALGOMeeting(algorandAlgod, docRef.id, meeting);
    } else {
      // txId = await settleASAMeeting(clientTESTNET, meeting);
      throw Error("no ASA at the moment");
    }
  }

  console.log("settleMeeting, result", result);

  // update meeting
  const updateObj = {
    settled: true,
    duration: meeting.duration,
  };
  if (result) {
    updateObj["txns.unlock"] = result.txId;
    updateObj["energy.A"] = result.energyA;
    updateObj["energy.CREATOR"] = result.energyCreator;
    updateObj["energy.B"] = result.energyB;
  }
  await docRef.update(updateObj); // not in parallel in case of early bugs

  const p1 = updateTopSpeeds(meeting);
  const p2 = updateTopDurations(meeting);
  return Promise.all([p1, p2]);
};

const settleALGOMeeting = async (
    algodclient,
    id,
    meeting,
) => {
  const note = Buffer.from(id + "." + meeting.speed.num + "." + meeting.speed.assetId).toString("base64");
  console.log("note", note);
  const lookup = await algorandIndexer.lookupAccountTransactions(process.env.ALGORAND_SYSTEM_ACCOUNT).txType("pay").assetID(0).notePrefix(note).minRound(19000000).do();
  console.log("lookup.transactions.length", lookup.transactions.length);

  if (lookup.transactions.length !== 1) return; // there should exactly one lock txn for this bid
  const txn = lookup.transactions[0];
  const sender = txn.sender;
  console.log("sender", sender, meeting.A, sender === meeting.addrA);
  if (sender !== meeting.addrA) return; // pay back to same account only
  const paymentTxn = txn["payment-transaction"];
  const receiver = paymentTxn.receiver;
  console.log("receiver", receiver, receiver === process.env.ALGORAND_SYSTEM_ACCOUNT);
  if (receiver !== process.env.ALGORAND_SYSTEM_ACCOUNT) return;

  const maxEnergy = paymentTxn.amount - 4 * MIN_TXN_FEE;
  console.log("maxEnergy", maxEnergy);
  if (maxEnergy !== meeting.energy.MAX) console.error("maxEnergy !== meeting.energy.MAX", maxEnergy, meeting.energy.MAX);

  let energy = maxEnergy;
  if (meeting.status !== "END_TIMER_CALL_PAGE") energy = Math.min(meeting.duration * meeting.speed.num, energy);
  console.log("energy", energy);

  const energyB = Math.ceil(0.9 * energy);
  console.log("energyB", energyB);
  const energyCreator = energy - energyB;
  console.log("energyCreator", energyCreator);
  const energyA = maxEnergy - energyB - energyCreator + (energyB === 0 ? MIN_TXN_FEE : 0) + (energyCreator === 0 ? MIN_TXN_FEE : 0);
  console.log("energyA", energyA);

  const txId = await runUnlock(algodclient, energyA, energyCreator, energyB, meeting.addrA, meeting.addrB);

  return {
    txId: txId,
    energyA: energyA,
    energyCreator: energyCreator,
    energyB: energyB,
  };
};

const runUnlock = async (algodclient, energyA, energyFee, energyB, addrA, addrB) => {
  const accountCreator = algosdk.mnemonicToSecretKey(process.env.SYSTEM_PK);
  console.log("accountCreator.addr", accountCreator.addr);
  const appArg0 = new TextEncoder().encode("UNLOCK");
  const appArg1 = algosdk.encodeUint64(energyA);
  const appArg2 = algosdk.encodeUint64(energyFee);
  const appArg3 = algosdk.encodeUint64(energyB);
  const appArgs = [appArg0, appArg1, appArg2, appArg3];
  const suggestedParams = await algodclient.getTransactionParams().do();
  const unlockTxn = algosdk.makeApplicationNoOpTxnFromObject({
    from: accountCreator.addr,
    appIndex: Number(process.env.ALGORAND_SYSTEM_ID),
    appArgs,
    accounts: [addrA, addrB],
    suggestedParams,
  });
  console.log("runUnlock, unlockTxn");

  // sign
  const stateTxnSigned = unlockTxn.signTxn(accountCreator.sk);
  console.log("runUnlock, signed");

  // send
  try {
    const {txId} = await algodclient.sendRawTransaction([stateTxnSigned]).do();
    console.log("runUnlock, sent", txId);

    // confirm
    const timeout = 5;
    await waitForConfirmation(algodclient, txId, timeout);
    console.log("runUnlock, confirmed");

    return txId;
  } catch (e) {
    console.log("error", e);
    throw Error(e);
  }
};

// every minute
const checkUserStatusInternal = async (T, usersColRef, status) => {
  const queryRef = usersColRef.where("status", "==", status).where("heartbeat", "<", T);
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
        active: false,
        end: admin.firestore.FieldValue.serverTimestamp(),
      };
      const meetingDocRef = db.collection("meetings").doc(meeting);
      const meetingPromise = meetingDocRef.update(meetingObj);
      promises.push(meetingPromise);
    }
  });
  return promises;
};
exports.checkUserStatus = functions.runWith(runWithObj).pubsub.schedule("* * * * *").onRun((context) => {
  console.log("context", context);
  const T = new Date();
  T.setSeconds(T.getSeconds() - 10);
  const usersColRef = db.collection("users");
  const p1 = checkUserStatusInternal(T, usersColRef, "ONLINE");
  const p2 = checkUserStatusInternal(T, usersColRef, "IDLE");
  return Promise.all([...p1, ...p2]);
});

const sendALGO = async (client, fromAccount, toAccount, amount) => {
  // txn
  const suggestedParams = await client.getTransactionParams().do();
  const note = new Uint8Array(Buffer.from("a gift from 2i2i", "utf8"));
  const transactionOptions = {
    from: fromAccount.addr,
    to: toAccount.addr,
    amount,
    note,
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

// exports.updateFX = functions.runWith(runWithObj).pubsub.schedule("* * * * *").onRun(async (context) => {
//   const colRef = db.collection("FX");
//   const settings = await colRef.doc("settings").get();
//   const ccys = settings.get("ccys");

//   const promises = [];
//   for(const ccy of ccys) {
//     if (ccy === "ALGO") continue;
//     const docRef = colRef.doc(`${ccy}ALGO`)
//     const p = docRef.update({
//       ts: admin.firestore.FieldValue.serverTimestamp(),
//       value: 1, // TODO connect API
//     });
//     promises.push(p);
//   }

//   return Promise.all(promises);
// });

// exports.test = functions.runWith(runWithObj).https.onCall(async (data, context) => {
//   const colRef = db.collection("FX");
//   const settings = await colRef.doc("settings").get();
//   const ccys = settings.get("ccys");

//   const promises = [];
//   for(const ccy of ccys) {
//     if (ccy === "ALGO") continue;
//     console.log(ccy);
//     const docRef = colRef.doc(`${ccy}ALGO`)
//     console.log(docRef);
//     const p = docRef.update({
//       ts: admin.firestore.FieldValue.serverTimestamp(),
//       value: 1, // TODO connect API
//     });
//     promises.push(p);
//   }

//   return Promise.all(promises);
// });

// const NOVALUE_ASSET_ID = 29147319;

// giftALGO({account: "2I2IXTP67KSNJ5FQXHUJP5WZBX2JTFYEBVTBYFF3UUJ3SQKXSZ3QHZNNPY"}, {auth: {uid: "uid"}})
exports.giftALGO = functions.runWith(runWithObj).https.onCall(async (data, context) => {
  // console.log("context", context);
  // console.log("data", data);
  // if (context.app == undefined) {
  //   throw new functions.https.HttpsError(
  //       "failed-precondition",
  //       "The function must be called from an App Check verified app.");
  // }
  // const uid = context.auth.uid;
  // if (!uid) return;

  // DO NOT GIFT ON mainnet
  if (process.env.ALGORAND_NET === "mainnet") return;

  const creatorAccount = algosdk.mnemonicToSecretKey(process.env.SYSTEM_PK);
  console.log("creatorAccount.addr", creatorAccount.addr);

  const userAccount = {addr: data.account};
  console.log("data.account", data.account);

  return sendALGO(algorandAlgod,
      creatorAccount,
      userAccount,
      500000);
});

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


const updateTopDurations = async (meeting) => updateTopMeetings("topDurations", "duration", meeting);
const updateTopSpeeds = async (meeting) => updateTopMeetings("topSpeeds", "speed.num", meeting);
const addTopMeeting = async (T, colRef, meeting) => {
  const docRefB = db.collection("users").doc(meeting.B);
  const docB = await T.get(docRefB);
  const nameB = docB.get("name");
  const docRefNewTopMeeting = colRef.doc();
  T.create(docRefNewTopMeeting, {
    B: meeting.B,
    name: nameB,
    duration: meeting.duration,
    speed: meeting.speed,
    ts: meeting.end,
  });
  return T;
};
const updateTopMeetings = async (collection, field, meeting) => {
  console.log("updateTopMeetings, collection, field", collection, field);
  if (meeting.duration === 0) return;
  if (meeting.speed.num === 0) return;
  const colRef = db.collection(collection);
  const query = colRef.orderBy(field, "desc").orderBy("ts");
  return db.runTransaction(async (T) => {
    const querySnapshot = await T.get(query);
    console.log("querySnapshot.size", querySnapshot.size);

    if (querySnapshot.size < 10) return addTopMeeting(T, colRef, meeting);

    for (let i = 0; i < querySnapshot.size; i++) {
      const queryDocSnapshot = querySnapshot.docs[i];
      const docField = queryDocSnapshot.get(field);
      console.log("i", i, docField, queryDocSnapshot.get("ts"));

      if (docField < meeting[field]) {
        console.log("yay");

        const docRefB = db.collection("users").doc(meeting.B);
        const docB = await T.get(docRefB);
        const nameB = docB.get("name");
        const docRefNewTopMeeting = colRef.doc();

        // remove last top meeting
        const queryDocSnapshotLast = querySnapshot.docs[querySnapshot.size - 1];
        T.delete(queryDocSnapshotLast.ref);

        // T = addTopMeeting(T, colRef, meeting);
        T.create(docRefNewTopMeeting, {
          B: meeting.B,
          name: nameB,
          duration: meeting.duration,
          speed: meeting.speed,
          ts: meeting.end,
        });

        break;
      }
    }
  });
};


// //////////////
// ADMIN
// const checkActiveBidsWithMeetingHelper = async(A, B, id) => {
//   // const bidOutDocSnapshot = await db.collection("users").doc(A).collection("bidOuts").doc(id).get();
//   // if (bidOutDocSnapshot.get("active")) {
//   //   console.log("bidOutDocSnapshot" + id);
//   //   // await bidOutDocSnapshot.ref.update({active: false});
//   // }
//   return db.collection("users").doc(A).collection("bidOuts").doc(id).get().then((bidOutDocSnapshot) => {
//     if (bidOutDocSnapshot.get("active")) {
//       console.log("bidOutDocSnapshot " + id);
//       // await bidInPrivateDocSnapshot.ref.update({active: false});
//     }
//   });
//   // const bidInPrivateDocSnapshot = await db.collection("users").doc(B).collection("bidInsPrivate").doc(id).get();
//   // if (bidInPrivateDocSnapshot.get("active")) {
//   //   console.log("bidInPrivateDocSnapshot" + id);
//   //   // await bidInPrivateDocSnapshot.ref.update({active: false});
//   // }
//   // return db.collection("users").doc(B).collection("bidInsPrivate").doc(id).get().then((bidInPrivateDocSnapshot) => {
//   //   if (bidInPrivateDocSnapshot.get("active")) {
//   //     console.log("bidInPrivateDocSnapshot " + id);
//   //     // await bidInPrivateDocSnapshot.ref.update({active: false});
//   //   }
//   // });
//   // const bidInPublicDocSnapshot = await db.collection("users").doc(B).collection("bidInsPublic").doc(id).get();
//   // return db.collection("users").doc(B).collection("bidInsPublic").doc(id).get().then((bidInPublicDocSnapshot) => {
//   //   if (bidInPublicDocSnapshot.get("active")) {
//   //     console.log("bidInPublicDocSnapshot " + id);
//   //     // await bidInPublicDocSnapshot.ref.update({active: false});
//   //   }
//   // });
//   // if (bidInPublicDocSnapshot.get("active")) {
//   //   console.log("bidInPublicDocSnapshot" + id);
//   //   // await bidInPublicDocSnapshot.ref.update({active: false});
//   // }
// };
// exports.checkActiveBidsWithMeeting = functions.https.onCall(async (data, context) => {
//   const meetingsQuerySnapshot = await db.collection("meetings").get();
//   const ps = [];
//   for (const meetingQueryDocSnapshot of meetingsQuerySnapshot.docs) {
//     const id = meetingQueryDocSnapshot.id;
//     const A = meetingQueryDocSnapshot.get("A");
//     const B = meetingQueryDocSnapshot.get("B");
//     const p = checkActiveBidsWithMeetingHelper(A, B, id);
//     ps.push(p);
//   }
//   await Promise.all(ps);
//   console.log("done");
// });


// //////////////
// OLD

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
//   console.log(process.env.ALGORAND_NET);
// });
