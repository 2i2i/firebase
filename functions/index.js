// main actions:
// createBid - A
// acceptBid - B
// acceptMeeting - A
// createRoom - A

// firebase use
// firebase functions:shell
// firebase deploy --only functions:meetingUpdated,functions:meetingUpdated
// ./functions/node_modules/eslint/bin/eslint.js functions --fix
// firebase emulators:start

// firebase firestore:indexes
// firebase deploy --only firestore:indexes

const functions = require("firebase-functions");
const algosdk = require("algosdk");
// algosdk.algosToMicroalgos(1);

// FX is ALGO per speed.assetId
const axios = require("axios");
const admin = require("firebase-admin");
admin.initializeApp(
    {
      "serviceAccountId": process.env.SERVICE_ACCOUNT_ID,
    },
);
const db = admin.firestore();
// const messaging = admin.messaging();
const {getAuth} = require("firebase-admin/auth");
const {FieldValue, Timestamp} = require("firebase-admin/firestore");

const https = require("https");
// const http = require("http");

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

const getUrl = async (url, callback) => {
  console.log("url", url);

  const request = https.request(url, (response) => {
    const data = [];

    response.on("data", (chunk) => {
      data.push(chunk);
      // console.log("chunk, data", chunk, data);
    });

    response.on("end", () => {
      // console.log("data", data);
      const body = JSON.parse(Buffer.concat(data).toString());
      // console.log("body", body);
      return callback(body);
    });
  });

  request.on("error", (error) => {
    console.log("An error", error);
  });

  request.end();
};

// runs every minute
const getFX = async (assetId, docRef) => {
  // eslint-disable-next-line max-len
  const url = `https://free-api.vestige.fi/asset/${assetId}/price?currency=ALGO`;
  // const url = `https://free-api.vestige.fi/asset/31566704/price?currency=ALGO`; // debug
  console.log("url", url);

  const callback = (data) => {
    if (data) {
      const d = new Date(0); // The 0 there is the key, which sets the date to the epoch
      d.setUTCSeconds(data.timestamp);
      return docRef.update({ts: d, value: data.price});
    }
  };

  return getUrl(url, callback);
};
exports.updateFX = functions.runWith(runWithObj).pubsub.schedule("* * * * *").onRun(async (context) => {
  const colRef = db.collection("FX");
  const querySnapshot = await colRef.get();
  const ps = [];
  for (const queryDocSnapshot of querySnapshot.docs) {
    const assetId = queryDocSnapshot.id;
    if (assetId === "0") continue;
    const p = getFX(assetId, queryDocSnapshot.ref);
    ps.push(p);
  }
  return Promise.all(ps);
});

// createToken({token: 'token'})
exports.createToken = functions.https.onCall(async (data, context) => {
  const id = data.token;

  let result;
  try {
    result = await getAuth().createCustomToken(id);
    functions.logger.info("Custom token for " + id + " is " + result);
  } catch (e) {
    result = "Error " + e.toString();
    functions.logger.info("Custom token for " + id + " Have " + result);
  }
  return {"result": result};
});

// exports.userCreated = functions.runWith(runWithObj).auth.user().onCreate((user) => {
//   const docRefUser = db.collection("users").doc(user.uid);
//   return docRefUser.create({
//     status: "ONLINE",
//     meeting: null,
//     bio: "",
//     name: "",
//     rating: 1,
//     numRatings: 0,
//     heartbeatBackground: FieldValue.serverTimestamp(),
//     heartbeatForeground: FieldValue.serverTimestamp(),
//     tags: [],
//     rule: {
//       // set also in frontend (userModel)
//       maxMeetingDuration: 300,
//       minSpeed: 0,
//       importance: {
//         lurker: 0,
//         chrony: 1,
//         highroller: 4,
//         eccentric: 0,
//       },
//     },
//     loungeHistory: [],
//     loungeHistoryIndex: -1,
//     blocked: [],
//     friends: [],
//     imageUrl: null,
//     socialLinks: [],
//   });
// });

const findTxn = async (meetingId, speed, A, addrA) => {
  console.log("findTxn, id, speed, A, addrA", meetingId, speed, A, addrA);
  const noteString = meetingId + "." + speed.num + "." + speed.assetId;
  const note = Buffer.from(noteString).toString("base64");
  console.log("noteString, note", noteString, note);
  const txType = speed.assetId === 0 ? "pay" : "axfer";
  console.log("txType", txType);
  const lookup = await algorandIndexer.lookupAccountTransactions(process.env.ALGORAND_SYSTEM_ACCOUNT).txType(txType).assetID(speed.assetId).notePrefix(note).minRound(process.env.ALGORAND_MIN_ROUND).do();
  console.log("lookup.transactions.length", lookup.transactions.length);

  if (lookup.transactions.length !== 1) throw ("lookup.transactions.length !== 1"); // there should exactly one lock txn for this bid
  const txn = lookup.transactions[0];
  const sender = txn.sender;
  console.log("sender", sender, A, sender === addrA);
  if (sender !== addrA) throw ("sender !== addrA"); // pay back to same account only
  console.log("txn", txn);
  const innerTxn = speed.assetId == 0 ? txn["payment-transaction"] : txn["asset-transfer-transaction"];
  const receiver = innerTxn.receiver;
  console.log("receiver", receiver, receiver === process.env.ALGORAND_SYSTEM_ACCOUNT);
  if (receiver !== process.env.ALGORAND_SYSTEM_ACCOUNT) throw ("receiver !== process.env.ALGORAND_SYSTEM_ACCOUNT");

  return innerTxn;
};

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

    const txn = await findTxn(bidId, speed, uid, addrA);

    const energyA = txn.amount - (txn["tx-type"] === "pay" ? 2 * MIN_TXN_FEE : 0); // give A unused coins (3-1=2)
    const {txId, error} = await runUnlock(algorandAlgod, energyA, 0, addrA, addrA, speed.assetId);
    if (error) return error;

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
// exports.bidAdded = functions.runWith(runWithObj).firestore
//     .document("users/{userId}/bidInsPublic/{bidId}")
//     .onCreate(async (change, context) => {
//       const userId = context.params.userId;
//       const docRefToken = db.collection("tokens").doc(userId);
//       const docToken = await docRefToken.get();
//       if (!docToken.exists) return; // no token

//       const token = docToken.get("token");

//       const message = {
//         notification: {
//           title: "2i2i",
//           body: "Someone wants to meet you",
//           image: process.env.NOTIFICATON_IMAGE,
//         },
//         webpush: {
//           headers: {
//             Urgency: "high",
//           },
//           fcm_options: {
//             link: `https://${process.env.DOMAIN}/myHangout`,
//           },
//         },
//         token: token,
//       };

//       // DEBUG
//       return messaging.send(message)
//           .then((response) => {
//             // Response is a message ID string.
//             console.log("Successfully sent message:", response);
//           })
//           .catch((error) => {
//             console.log("Error sending message:", error);
//           });
//     });

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
        const docUser = await T.get(docRefUser);
        const numRatings = docUser.get("numRatings") ?? 0;
        const userRating = docUser.get("rating") ?? 1;
        const newNumRatings = numRatings + 1;
        const newRating = (userRating * numRatings + meetingRating) / newNumRatings; // works for numRatings == 0
        return T.update(docRefUser, {
          rating: newRating,
          numRatings: newNumRatings,
        });
      });
    });

// const notifyA = async (A) => {
//   const docRefToken = db.collection("tokens").doc(A);
//   const docToken = await docRefToken.get();
//   console.log("notifyA", docToken);
//   if (!docToken.exists) return; // no token

//   const token = docToken.get("token");

//   const message = {
//     "to": token,
//     "notification": {
//       title: "2i2i",
//       body: "The Host is calling you",
//     },
//     "mutable_content": true,
//     "content_available": true,
//     "content-available": true,
//     "priority": "high",
//     "data": {
//       title: "2i2i",
//       body: "The Host is calling you",
//       imageUrl: process.env.NOTIFICATON_IMAGE,
//       type: "Call",
//     },
//     "webpush": {
//       headers: {
//         Urgency: "high",
//       },
//       fcm_options: {
//         link: `https://${process.env.DOMAIN}`,
//       },
//     },
//     // "token": token,
//   };

//   // DEBUG
//   console.log("notifyA send");
//   return messaging.send(message)
//       .then((response) => {
//         // Response is a message ID string.
//         console.log("Successfully sent message:", response);
//       })
//       .catch((error) => {
//         console.log("Error sending message:", error);
//       });
// };
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

      // const p2 = notifyA(meeting.A);

      // return Promise.all([p1, p2]);
      return p1;
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
    const start = FieldValue.serverTimestamp();
    let statusHistoryTS = null;
    for (const s of newMeeting.statusHistory) {
      if (s.value === "RECEIVED_REMOTE_A" || s.value === "RECEIVED_REMOTE_B") statusHistoryTS = s.ts;
    }
    // console.log("meetingUpdated, start", start);

    return change.after.ref.update({
      start: start,
      status: "CALL_STARTED",
      statusHistory: FieldValue.arrayUnion({
        value: "CALL_STARTED",
        ts: statusHistoryTS, // start,
      }),
    });
  }

  // is meeting done?
  if (!newMeeting.status.startsWith("END_")) return 0;

  const promises = [];

  if (newMeeting.status === "END_END") {
    newMeeting.duration = newMeeting.start !== null ? newMeeting.end.seconds - newMeeting.start.seconds : 0;
    // console.log("meetingUpdated, newMeeting.duration", newMeeting.start, newMeeting.end.seconds, newMeeting.start.seconds, newMeeting.duration);

    return settleMeeting(change.after.ref, newMeeting);
  }

  const updateEndPromise = change.after.ref.update({
    end: FieldValue.serverTimestamp(),
    status: "END_END",
  });
  promises.push(updateEndPromise);

  // unlock users
  if (newMeeting.status === "END_DISCONNECT") {
    const colRef = db.collection("users");
    const A = newMeeting.A;
    const B = newMeeting.B;
    const docRefA = colRef.doc(A);
    const docRefB = colRef.doc(B);
    const unlockAPromise = docRefA.update({meeting: null});
    const unlockBPromise = docRefB.update({meeting: null});
    promises.push(unlockAPromise, unlockBPromise);
    console.log("meetingUpdated, users unlocked");
  }

  return Promise.all(promises);
});

// changes meeting
const settleMeeting = async (docRef, meeting) => {
  console.log("settleMeeting, meeting", meeting);

  const meetingId = docRef.id;

  let result = null;
  if (meeting.speed.num !== 0) {
    const txn = await findTxn(meetingId, meeting.speed, meeting.A, meeting.addrA);
    if (meeting.speed.assetId === 0) {
      result = await settleALGOMeeting(algorandAlgod, meeting, txn);
    } else {
      result = await settleASAMeeting(algorandAlgod, meeting, txn);
    }

    if (!result.error) await send2i2iCoins(meeting);
  }

  console.log("settleMeeting, result", result);

  // update meeting
  const updateObj = {
    settled: true,
    duration: meeting.duration,
  };
  meeting.settled = true; // local change
  if (result) {
    updateObj["txns.unlock"] = result.txId;
    meeting.txns.unlock = result.txId; // local change
    updateObj["energy.A"] = result.energyA;
    meeting.energy.A = result.energyA; // local change
    updateObj["energy.CREATOR"] = result.energyCreator;
    meeting.energy.CREATOR = result.energyCreator; // local change
    updateObj["energy.B"] = result.energyB;
    meeting.energy.B = result.energyB; // local change
  }
  await docRef.update(updateObj); // not in parallel in case of early bugs

  await updateRedeemBoth(meeting);

  const p1 = updateTopSpeeds(meetingId, meeting);
  const p2 = updateTopDurations(meetingId, meeting);
  const p3 = updateTopValues(meetingId, meeting);
  const p4 = updateNumMeetings();
  return Promise.all([p1, p2, p3, p4]);
};

const updateNumMeetings = async () => db.collection("system").doc("stats").update({numMeetings: FieldValue.increment(1)});

const updateRedeemBoth = async (meeting) => {
  console.log("updateRedeemBoth, meeting.txns.unlock", meeting.txns.unlock);
  if (!meeting.txns.unlock) return;
  const txInfo = await algorandIndexer.lookupTransactionByID(meeting.txns.unlock).do();
  const p1 = updateRedeem(txInfo, meeting.A, meeting.addrA, meeting.speed.assetId, meeting.energy.A);
  const p2 = updateRedeem(txInfo, meeting.B, meeting.addrB, meeting.speed.assetId, meeting.energy.B);
  return Promise.all([p1, p2]);
};
const updateRedeem = async (txInfo, uid, targetAlgorand, assetId, amount) => {
  // const txId = 'ZM3DT25HHVEBA3XSGHXPSERRZQD5XMJCA67OZCPKUWDJGVLDRFQA';

  console.log("txInfo, uid, targetAlgorand, assetId, amount", uid, targetAlgorand, assetId, amount);
  console.log("1", txInfo.transaction["inner-txns"]);

  let redeem = true;
  for (const t of txInfo.transaction["inner-txns"] ?? []) {
    const receiver = assetId === 0 ? t["payment-transaction"]?.receiver : t["asset-transfer-transaction"]?.receiver;
    console.log("receiver", receiver);
    // console.log('2', t['payment-transaction']);
    // console.log('3', t['asset-transfer-transaction']);
    // receiver, amount
    if (receiver === targetAlgorand) {
      redeem = false;
    }
  }

  if (!redeem) return;

  return addRedeem(uid, assetId, amount);
};

const settleMeetingCalcEnergy = (
    amount,
    meeting,
) => {
  const maxEnergy = amount - (meeting.speed.assetId == 0 ? 3 * MIN_TXN_FEE : 0);
  console.log("maxEnergy", maxEnergy);
  if (maxEnergy !== meeting.energy.MAX) console.error("maxEnergy !== meeting.energy.MAX", maxEnergy, meeting.energy.MAX);

  let energy = maxEnergy;
  if (meeting.status !== "END_TIMER_CALL_PAGE") energy = Math.min(meeting.duration * meeting.speed.num, energy);
  console.log("energy", energy);

  const energyB = Math.ceil(0.9 * energy);
  console.log("energyB", energyB);
  const energyCreator = energy - energyB;
  console.log("energyCreator", energyCreator);
  const energyA = maxEnergy - energyB - energyCreator + (energyB === 0 ? MIN_TXN_FEE : 0);
  console.log("energyA", energyA);

  return {
    energyA,
    energyCreator,
    energyB,
  };
};

const settleALGOMeeting = async (
    algodclient,
    meeting,
    paymentTxn,
) => {
  let {energyA, energyCreator, energyB} = settleMeetingCalcEnergy(paymentTxn.amount, meeting);

  if (energyB === 0) energyA += MIN_TXN_FEE; // give A unused coins

  const {txId, error} = await runUnlock(algodclient, energyA, energyB, meeting.addrA, meeting.addrB);

  return {
    txId,
    energyA,
    energyCreator,
    energyB,
    error,
  };
};

const settleASAMeeting = async (
    algodclient,
    meeting,
    axferTxn,
) => {
  const {energyA, energyCreator, energyB} = settleMeetingCalcEnergy(axferTxn.amount, meeting);

  const {
    txId,
    error,
  } = await runUnlock(algodclient, energyA, energyB, meeting.addrA, meeting.addrB, meeting.speed.assetId);

  return {
    txId,
    energyA,
    energyCreator,
    energyB,
    error,
  };
};

// const isOptedIn = async (addr, ) => {
//   let accountInfo = await algodclient.accountInformation(account).do();
//     for (idx = 0; idx < accountInfo['assets'].length; idx++) {
//         let scrutinizedAsset = accountInfo['assets'][idx];
//         if (scrutinizedAsset['asset-id'] == assetid) {
//             let myassetholding = JSON.stringify(scrutinizedAsset, undefined, 2);
//             console.log("assetholdinginfo = " + myassetholding);
//             break;
//         }
//     }

// }

const send2i2iCoins = async (meeting) => {
  const partOfEnergy = 0; // energyCreator * 0.005 * 0.5 * FX; // need fx ALGO/2I2I
  const perMeeting = 1; // 92233720; // 0.5*0.01*10^(-9)*(2^64-1);
  const amount = perMeeting + partOfEnergy;
  await send2i2iCoinsCore(amount, meeting.addrA, meeting.A);
  await send2i2iCoinsCore(amount, meeting.addrB, meeting.B);
};
const send2i2iCoinsCore = async (amount, toAddr, uid) => {
  console.log("send2i2iCoinsCore, amount, toAddr, uid", amount, toAddr, uid);

  if (!amount) return;

  const assetId = process.env.ASA_ID * 1;

  if (!toAddr) {
    console.log("send2i2iCoinsCore !toAddr addRedeem");
    return addRedeem(uid, assetId, amount);
  }

  // is toAddr opted-in?
  // toAddr

  const signAccount = algosdk.mnemonicToSecretKey(process.env.SYSTEM_PK);

  console.log("send2i2iCoinsCore before sendASA, assetId", assetId);
  const {txId, error} = await sendASA(algorandAlgod,
      process.env.CREATOR_ACCOUNT,
      toAddr,
      signAccount,
      amount,
      assetId,
  );

  if (error) {
    console.log("send2i2iCoinsCore before addRedeem");
    return addRedeem(uid, assetId, amount);
  }

  return txId;
};

const addRedeem = (uid, assetId, amount) => {
  console.log("addRedeem, uid, assetId, amount", uid, assetId, amount);
  const docRef = db.collection("redeem").doc(uid);
  return docRef.set({
    // FieldValue.increment(): works if key does not exist yet:
    // https://firebase.google.com/docs/firestore/manage-data/add-data#increment_a_numeric_value
    [assetId]: FieldValue.increment(amount),
  }, {merge: true});
};

// redeem({assetId: 78585497, addr: "addr"})
exports.redeem = functions.runWith(runWithObj).https.onCall(async (data, context) => {
  const uid = context.auth.uid;
  const assetId = data.assetId;
  const addr = data.addr;

  console.log("redeem, uid, assetId, addr", uid, assetId, addr);

  return db.runTransaction(async (T) => {
    // read db
    const docRef = db.collection("redeem").doc(uid);
    const doc = await T.get(docRef);

    const amount = doc.get(assetId.toString());
    console.log("redeem, amount", amount);

    if (!amount) return `uid=${uid}, assetId=${assetId} nothing to redeem`;

    // send coins
    let resultObj;
    console.log("redeem, assetId, process.env.ASA_ID, assetId === process.env.ASA_ID", assetId, process.env.ASA_ID * 1, assetId === process.env.ASA_ID * 1);
    if (assetId === process.env.ASA_ID * 1) {
      resultObj = await run2i2iRedeem(algorandAlgod, amount, addr);
    } else {
      resultObj = await runRedeem(algorandAlgod, amount, addr, assetId);
    }
    const {txId, error} = resultObj;
    console.log("redeem, txId, error", txId, error);
    if (error) return `${error}`;

    // update db
    await T.update(docRef, {
      // FieldValue.increment(): works if key does not exist yet:
      // https://firebase.google.com/docs/firestore/manage-data/add-data#increment_a_numeric_value
      [assetId]: FieldValue.increment(-amount),
    });

    return txId;
  });
});

const run2i2iRedeem = async (algodclient, amount, addr) => {
  console.log("run2i2iRedeem", amount, addr, process.env.ASA_ID * 1);

  const signerAccount = algosdk.mnemonicToSecretKey(process.env.SYSTEM_PK);
  console.log("signerAccount.addr", signerAccount.addr);

  const suggestedParams = await algodclient.getTransactionParams().do();
  const txnObj = {
    from: process.env.CREATOR_ACCOUNT,
    to: addr,
    amount: amount,
    assetIndex: process.env.ASA_ID * 1,
    suggestedParams,
  };

  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject(txnObj);
  console.log("run2i2iRedeem, txn");

  // sign
  const stateTxnSigned = txn.signTxn(signerAccount.sk);
  console.log("run2i2iRedeem, signed");

  // send
  try {
    const {txId} = await algodclient.sendRawTransaction([stateTxnSigned]).do();
    console.log("run2i2iRedeem, sent", txId);

    // confirm
    const timeout = 5;
    await waitForConfirmation(algodclient, txId, timeout);
    console.log("run2i2iRedeem, confirmed");

    return {
      txId,
      error: null,
    };
  } catch (e) {
    console.log("error", e);
    return {
      txId: null,
      error: e,
    };
  }
};

const runRedeem = async (algodclient, amount, addr, assetId) => {
  console.log("runRedeem", amount, addr, assetId);

  const signerAccount = algosdk.mnemonicToSecretKey(process.env.SYSTEM_PK);
  console.log("signerAccount.addr", signerAccount.addr);

  const appArg0 = new TextEncoder().encode("REDEEM");
  const appArg1 = algosdk.encodeUint64(amount);
  const appArgs = [appArg0, appArg1];

  const suggestedParams = await algodclient.getTransactionParams().do();
  const txnObj = {
    from: process.env.CREATOR_ACCOUNT,
    appIndex: Number(process.env.ALGORAND_SYSTEM_ID),
    appArgs,
    accounts: [addr],
    suggestedParams,
  };
  if (assetId !== 0) txnObj.foreignAssets = [assetId];

  const txn = algosdk.makeApplicationNoOpTxnFromObject(txnObj);
  console.log("runRedeem, txn");

  // sign
  const stateTxnSigned = txn.signTxn(signerAccount.sk);
  console.log("runRedeem, signed");

  // send
  try {
    const {txId} = await algodclient.sendRawTransaction([stateTxnSigned]).do();
    console.log("runRedeem, sent", txId);

    // confirm
    const timeout = 5;
    await waitForConfirmation(algodclient, txId, timeout);
    console.log("runRedeem, confirmed");

    return {
      txId,
      error: null,
    };
  } catch (e) {
    console.log("error", e);
    return {
      txId: null,
      error: e,
    };
  }
};

const runUnlock = async (algodclient, energyA, energyB, addrA, addrB, assetId = null) => {
  console.log("runUnlock", energyA, energyB, addrA, addrB, assetId);
  const signerAccount = algosdk.mnemonicToSecretKey(process.env.SYSTEM_PK);
  console.log("signerAccount.addr", signerAccount.addr);

  const runA = 0 < energyA && addrA;
  const runB = 0 < energyB && addrB;
  if (!runA && !runB) {
    return {
      txId: null,
      error: "nothing to unlock",
    };
  }

  const appArg0 = new TextEncoder().encode("UNLOCK");
  const appArgs = [appArg0];
  const accounts = [];

  if (runA) {
    const appArgA = algosdk.encodeUint64(energyA);
    appArgs.push(appArgA);
    accounts.push(addrA);
  }

  if (runB) {
    const appArgB = algosdk.encodeUint64(energyB);
    appArgs.push(appArgB);
    accounts.push(addrB);
  }

  const suggestedParams = await algodclient.getTransactionParams().do();
  const unlockObj = {
    from: process.env.CREATOR_ACCOUNT,
    appIndex: Number(process.env.ALGORAND_SYSTEM_ID),
    appArgs,
    accounts: accounts,
    suggestedParams,
  };
  if (assetId) unlockObj.foreignAssets = [assetId];

  const unlockTxn = algosdk.makeApplicationNoOpTxnFromObject(unlockObj);
  console.log("runUnlock, unlockTxn");

  // sign
  const stateTxnSigned = unlockTxn.signTxn(signerAccount.sk);
  console.log("runUnlock, signed");

  // send
  try {
    const {txId} = await algodclient.sendRawTransaction([stateTxnSigned]).do();
    console.log("runUnlock, sent", txId);

    // confirm
    const timeout = 5;
    await waitForConfirmation(algodclient, txId, timeout);
    console.log("runUnlock, confirmed");

    return {
      txId,
      error: null,
    };
  } catch (e) {
    console.log("error", e);
    return {
      txId: null,
      error: e,
    };
  }
};

// every minute
const disconnectMeeting = async (meetingId) => {
  console.log("disconnectMeeting, meetingId", meetingId);

  const meetingObj = {
    status: "END_DISCONNECT",
    statusHistory: FieldValue.arrayUnion({value: "END_DISCONNECT", ts: Timestamp.now()}),
    active: false,
    end: FieldValue.serverTimestamp(),
  };
  const meetingDocRef = db.collection("meetings").doc(meetingId);

  const meetingDoc = await meetingDocRef.get();
  const A = meetingDoc.get("A");
  const B = meetingDoc.get("B");

  const colRef = db.collection("users");
  const docRefA = colRef.doc(A);
  const docRefB = colRef.doc(B);
  const unlockObj = {meeting: null};

  return db.runTransaction(async (T) => {
    T.update(meetingDocRef, meetingObj);
    T.update(docRefA, unlockObj);
    T.update(docRefB, unlockObj);
  });
};
const disconnectIfNeeded = async (queryDocSnapshotUser, ps) => {
  const meetingId = queryDocSnapshotUser.get("meeting");
  if (meetingId) {
    const p = disconnectMeeting(meetingId);
    ps.push(p);
  }
};
exports.checkUserStatus = functions.runWith(runWithObj).pubsub.schedule("* * * * *").onRun((context) => {
  const T = new Date();
  T.setSeconds(T.getSeconds() - 10);
  console.log("checkUserStatus, T", T);

  const usersColRef = db.collection("users");
  const ps = [];

  // not OFFLINE, both HBs old => OFFLINE
  const queryRefForOnline = usersColRef.where("status", "==", "ONLINE").where("heartbeatForeground", "<", T);
  queryRefForOnline.get().then((querySnapshot) => {
    console.log("checkUserStatus, queryRefForOnline", querySnapshot.size);
    querySnapshot.forEach(async (queryDocSnapshotUser) => {
      console.log("checkUserStatus, queryRefForOnline, queryDocSnapshotUser.id", queryDocSnapshotUser.id);
      const heartbeatBackground = queryDocSnapshotUser.get("heartbeatBackground");
      console.log("checkUserStatus, queryRefForOnline, heartbeatBackground", heartbeatBackground);
      if (heartbeatBackground < T) {
        console.log("checkUserStatus, queryRefForOnline, heartbeatBackground < T");
        const p = queryDocSnapshotUser.ref.update({status: "OFFLINE"});
        ps.push(p);
        disconnectIfNeeded(queryDocSnapshotUser, ps);
      } else {
        console.log("checkUserStatus, queryRefForOnline, NOT heartbeatBackground < T");
        const p = queryDocSnapshotUser.ref.update({status: "IDLE"});
        ps.push(p);
      }
    });
  });

  const queryRefForIdle = usersColRef.where("status", "==", "IDLE").where("heartbeatBackground", "<", T);
  queryRefForIdle.get().then((querySnapshot) => {
    console.log("checkUserStatus, queryRefForIdle", querySnapshot.size);
    querySnapshot.forEach(async (queryDocSnapshotUser) => {
      console.log("checkUserStatus, queryRefForIdle, queryDocSnapshotUser.id", queryDocSnapshotUser.id);
      const p = queryDocSnapshotUser.ref.update({status: "OFFLINE"});
      ps.push(p);
      disconnectIfNeeded(queryDocSnapshotUser, ps);
    });
  });

  // OFFLINE, HBBack new => IDLE
  const queryRefForOffline = usersColRef.where("status", "==", "OFFLINE").where("heartbeatBackground", ">=", T);
  queryRefForOffline.get().then((querySnapshot) => {
    console.log("checkUserStatus, queryRefForOffline", querySnapshot.size);
    querySnapshot.forEach(async (queryDocSnapshotUser) => {
      console.log("checkUserStatus, queryRefForOffline, queryDocSnapshotUser.id", queryDocSnapshotUser.id);
      const p = queryDocSnapshotUser.ref.update({status: "IDLE"});
      ps.push(p);
    });
  });

  console.log("checkUserStatus, ps", ps.length);

  return Promise.all(ps);
});
// commented un used code due to lint errors
// const sendALGO = async (algodclient, fromAccountAddr, toAccountAddr, signAccount, amount, wait = false) => {
//   // txn
//   const suggestedParams = await algodclient.getTransactionParams().do();
//   const transactionOptions = {
//     from: fromAccountAddr,
//     to: toAccountAddr,
//     amount,
//     suggestedParams,
//   };
//   const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject(
//       transactionOptions,
//   );
//
//   // sign
//   const signedTxn = txn.signTxn(signAccount.sk);
//
//   // send raw
//   try {
//     const {txId} = await algodclient.sendRawTransaction(signedTxn).do();
//     console.log("txId", txId);
//
//     // confirm
//     if (wait) {
//       const timeout = 5;
//       await waitForConfirmation(algodclient, txId, timeout);
//       console.log("sendALGO, confirmed");
//     }
//
//     return {
//       txId,
//       error: null,
//     };
//   } catch (e) {
//     console.log("error", e);
//     return {
//       txId: null,
//       error: e,
//     };
//   }
// };

const sendASA = async (algodclient, fromAccountAddr, toAccountAddr, signAccount, amount, assetIndex, wait = false) => {
  // txn
  const suggestedParams = await algodclient.getTransactionParams().do();
  const transactionOptions = {
    from: fromAccountAddr,
    to: toAccountAddr,
    assetIndex,
    amount,
    suggestedParams,
  };
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject(
      transactionOptions,
  );

  // sign
  const signedTxn = txn.signTxn(signAccount.sk);

  // send raw
  try {
    const {txId} = await algodclient.sendRawTransaction(signedTxn).do();
    console.log("txId", txId);

    // confirm
    if (wait) {
      const timeout = 5;
      await waitForConfirmation(algodclient, txId, timeout);
      console.log("sendALGO, confirmed");
    }

    return {
      txId,
      error: null,
    };
  } catch (e) {
    console.log("error", e);
    return {
      txId: null,
      error: e,
    };
  }
};

exports.updateDeepLinks = functions.https.onCall(async (data, context) => {
  const usersColRef = await db.collection("users");
  const querySnapshot = await usersColRef.get();
  for (const queryDocSnapshot of querySnapshot.docs) {
    const url = queryDocSnapshot.get("url");
    if (url != null && !url.toString().includes("2i2ishare")) {
      console.log("url = " + url);
      const data = queryDocSnapshot.data();
      data.url = await createDynamicLink(queryDocSnapshot.id);
    }
  }
});

exports.getDeepLink = functions.https.onCall(async (data, context) => {
  if (data != null && data.id != null) {
    const url = await createDynamicLink(data.id);
    return {"url": url};
  }
  return {"url": process.env["host"]+"/user/"+data.id};
});

const createDynamicLink = async (userId) => {
  const data = {
    "dynamicLinkInfo": {
      "domainUriPrefix": process.env["domainUriPrefix "],
      "link": process.env["host"]+"/user/"+userId,
      "androidInfo": {
        "androidPackageName": "app.i2i2",
        "androidFallbackLink": process.env["host"],
      },
      "iosInfo": {
        "iosBundleId": "app.2i2i",
        "iosFallbackLink": process.env["host"],
        "iosIpadFallbackLink": process.env["host"],
        "iosIpadBundleId": "app.2i2i",
        "iosAppStoreId": "1609689141",
      },
    },
  };
  const url = "https://firebasedynamiclinks.googleapis.com/v1/shortLinks?key=";
  const response = await axios.post(url+process.env["PROJECT_KEY"], data);
  if (response.status === 200) {
    const newURL = response.data.shortLink;
    console.log("newURL = " + newURL);
    return newURL;
  }
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
//       ts: FieldValue.serverTimestamp(),
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
//       ts: FieldValue.serverTimestamp(),
//       value: 1, // TODO connect API
//     });
//     promises.push(p);
//   }

//   return Promise.all(promises);
// });

// const NOVALUE_ASSET_ID = 29147319;

// giftALGO({account: "2I2IXTP67KSNJ5FQXHUJP5WZBX2JTFYEBVTBYFF3UUJ3SQKXSZ3QHZNNPY"}, {auth: {uid: "uid"}})
// exports.giftALGO = functions.runWith(runWithObj).https.onCall(async (data, context) => {
//   // console.log("context", context);
//   // console.log("data", data);
//   // if (context.app == undefined) {
//   //   throw new functions.https.HttpsError(
//   //       "failed-precondition",
//   //       "The function must be called from an App Check verified app.");
//   // }
//   // const uid = context.auth.uid;
//   // if (!uid) return;

//   // DO NOT GIFT ON mainnet
//   if (process.env.ALGORAND_NET === "mainnet") return;

//   const creatorAccount = algosdk.mnemonicToSecretKey(process.env.SYSTEM_PK);
//   console.log("creatorAccount.addr", creatorAccount.addr);

//   const userAccount = {addr: data.account};
//   console.log("data.account", data.account);

//   return sendALGO(algorandAlgod,
//       creatorAccount.addr,
//       userAccount.addr,
//       creatorAccount,
//       500000);
// });

// exports.giftASA = functions.runWith({minInstances: MIN_INSTANCES}).https.onCall(async (data, context) => {
//   const creatorAccount = algosdk.mnemonicToSecretKey(CREATOR_PRIVATE_KEY);
//   console.log("creatorAccount.addr", creatorAccount.addr);

//   const userAccount = {addr: data.account};
//   console.log("data.account", data.account);

//   return sendASA(clientTESTNET,
//       creatorAccount.addr,
//       userAccount.addr,
//       creatorAccount,
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

// ////
// TOP

const TOP_SIZE = 10;

const updateTopValues = async (meetingId, meeting) => updateTopMeetings("topValues", meetingId, meeting, topValueValue);
const updateTopSpeeds = async (meetingId, meeting) => updateTopMeetings("topSpeeds", meetingId, meeting, topSpeedValue);
const updateTopDurations = async (meetingId, meeting) => updateTopMeetings("topDurations", meetingId, meeting, topDurationValue);

const topValueValue = (meeting) => meeting.speed.num * meeting.FX * meeting.duration;
const topSpeedValue = (meeting) => meeting.speed.num * meeting.FX;
const topDurationValue = (meeting) => meeting.duration;

const getNamesForTopMeeting = async (T, meeting) => {
  const docRefA = db.collection("users").doc(meeting.A);
  const docRefB = db.collection("users").doc(meeting.B);
  const docRefAGet = T.get(docRefA);
  const docRefBGet = T.get(docRefB);
  const docRefResults = await Promise.all([docRefAGet, docRefBGet]);
  const docA = docRefResults[0];
  const docB = docRefResults[1];
  const A = docA.get("name");
  const B = docB.get("name");
  return {A, B};
};
const addTopMeeting = async (T, colRef, meetingId, meeting, valueFn, worst) => {
  console.log("addTopMeeting, meetingId", meetingId);

  if (worst) T.delete(worst);

  const names = await getNamesForTopMeeting(T, meeting);
  console.log("addTopMeeting, names", names);

  const obj = topObj(meeting, names.A, names.B, valueFn);
  console.log("addTopMeeting, obj", obj);

  const docRefNewTopMeeting = colRef.doc(meetingId);
  return T.create(docRefNewTopMeeting, obj);
};
const topObj = (meeting, nameA, nameB, valueFn) => {
  return {
    A: meeting.A,
    B: meeting.B,
    nameA,
    nameB,
    ts: meeting.end,
    FX: meeting.FX,
    speed: meeting.speed,
    duration: meeting.duration,
    value: valueFn(meeting),
  };
};

const updateTopMeetings = async (collection, meetingId, meeting, valueFn) => {
  console.log("updateTopMeetings, collection, meetingId, meeting.settled, meeting.speed.num, meeting.duration", collection, meetingId, meeting.settled, meeting.speed.num, meeting.duration);

  if (!meeting.settled) return;
  if (meeting.speed.num === 0) return;
  if (meeting.duration === 0) return;

  const colRef = db.collection(collection);
  const query = colRef.orderBy("value", "desc").orderBy("ts");

  const added = await db.runTransaction(async (T) => {
    const querySnapshot = await T.get(query);
    console.log("querySnapshot.size", querySnapshot.size);

    let worst = null;
    if (querySnapshot.size < TOP_SIZE) {
      await addTopMeeting(T, colRef, meetingId, meeting, valueFn, worst);
      return true;
    }

    for (let i = 0; i < querySnapshot.size; i++) {
      const queryDocSnapshot = querySnapshot.docs[i];
      const value = queryDocSnapshot.get("value");
      console.log("i", i, value, queryDocSnapshot.get("ts"));

      const valueMeeting = valueFn(meeting);
      if (valueMeeting && value < valueMeeting) {
        worst = querySnapshot.docs[querySnapshot.size - 1].ref;
        console.log("new record, worst.id", worst.id);
        await addTopMeeting(T, colRef, meetingId, meeting, valueFn, worst);
        return true;
      }
    }

    return false;
  });

  return added;
};

// TOP
// ////

const deleteDocsInCollection = (colRef, promises) =>
  colRef.listDocuments().then((docRefs) => {
    docRefs.forEach((docRef) => promises.push(docRef.delete()));
  });
const deleteMeInternal = (uid) => {
  const p = [];

  p.push(admin.auth().deleteUsers([uid]));
  p.push(db.collection("devices").doc(uid).delete());
  p.push(db.collection("tokens").doc(uid).delete());

  const userDocRef = db.collection("users").doc(uid);
  deleteDocsInCollection(userDocRef.collection("algorand_accounts"), p);
  deleteDocsInCollection(userDocRef.collection("bidInsPrivate"), p);
  deleteDocsInCollection(userDocRef.collection("bidInsPublic"), p);
  deleteDocsInCollection(userDocRef.collection("bidOuts"), p);
  deleteDocsInCollection(userDocRef.collection("ratings"), p);
  deleteDocsInCollection(userDocRef.collection("chat"), p);
  p.push(userDocRef.delete());

  // TODO del image in storage

  return Promise.all(p);
};
// deleteMe({})
// exports.deleteMe = functions.https.onCall(async (data, context) => deleteMeInternal('0G0vv08yfbR5ZRPbaUA4UaQFGXk2'));
exports.deleteMe = functions.https.onCall(async (data, context) => deleteMeInternal(context.auth.uid));

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
//   sendASA(client, account.addr, account.addr, account, 0, assetIndex);


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
//   const listUsersResult = await admin.auth().listUsers();
//   return admin.auth().deleteUsers(listUsersResult.users.map(u => u.uid));
// });
// exports.deleteUsers = functions.https.onCall(async (data, context) => {
//   // // search
//   // const listUsersResult = await admin.auth().listUsers();
//   // const p = [];
//   // for (const user of listUsersResult.users) {
//   //   const userDocRef = db.collection("users").doc(user.uid);
//   //   const userDoc = await userDocRef.get();
//   //   const name = userDoc.get("name");
//   //   if (!name) {
//   //     p.push(user.uid);
//   //     continue;
//   //   }
//   //   const lName = name.toLowerCase();
//   //   if (lName.includes("chandresh") || lName.includes("test") || lName.includes("ravi")) {
//   //     p.push(user.uid);
//   //     continue;
//   //   }
//   // }
//   // const ps = p.join("\",\"");
//   // console.log(ps);

//   // delete
//   // uids = [];
//   // for (const uid of uids) {
//   //   console.log(uid);
//   //   await deleteMeInternal(uid);
//   // }
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

// exports.resetTop = functions.https.onCall(async (data, context) => {
//   const colRef = db.collection("meetings");
//   const querySnapshot = await colRef.get();
//   console.log("querySnapshot.size", querySnapshot.size);
//   for (const queryDocSnapshot of querySnapshot.docs) {
//     const meetingId = queryDocSnapshot.id;
//     console.log("meetingId", meetingId);
//     const meeting = queryDocSnapshot.data();

//     if (!meeting.settled) continue;

//     const p1 = updateTopValues(meetingId, meeting).catch((_) => {});
//     const p2 = updateTopSpeeds(meetingId, meeting).catch((_) => {});
//     const p3 = updateTopDurations(meetingId, meeting).catch((_) => {});
//     await Promise.all([p1, p2, p3]);
//   }
//   console.log("done");
// });

// exports.addFXToMeetings = functions.https.onCall(async (data, context) => {
//   const colRef = db.collection("meetings");
//   const querySnapshot = await colRef.get();
//   const ps = [];
//   for (const queryDocSnapshot of querySnapshot.docs) {
//     const FX = queryDocSnapshot.get("FX");
//     if (FX) continue;
//     const p = queryDocSnapshot.ref.update({FX: 1});
//     ps.push(p);
//   }
//   return Promise.all(ps);
// });

// exports.addFX = functions.https.onCall(async (data, context) => {
//   const assetIds = [31566704, 137594422, 226701642, 724480511, 793124631, 283820866, 300208676, 287867876, 388592191, 27165954, 312769, 523683256, 571576867, 747635241, 470842789, 712012773, 818432243, 900652777, 444035862, 744665252, 559219992, 753137719, 403499324, 386192725, 692432647, 913799044, 386195940, 607591690, 511484048];
//   // const assetIds = [31566704];
//   for (const assetId of assetIds) {
//     console.log('assetId', assetId);
//     const url = `https://algoindexer.algoexplorerapi.io/v2/assets/${assetId}`;
//     const callback = (data) => {
//       if (data) {
//         console.log('data', data.asset);
//         const obj = {
//           name: data.asset.params.name,
//           unitname: data.asset.params['unit-name'],
//           iconUrl: `https://asa-list.tinyman.org/assets/${data.asset.index}/icon.png`,
//           decimals: data.asset.params.decimals,
//           ts: 0,
//           value: 0,
//         }
//         console.log('obj', obj);
//         const docRef = db.collection('FX').doc(assetId.toString());
//         return docRef.set(obj);
//       } else {
//         console.log('else');
//       }
//     }
//     await getUrl(url, callback);
//   }
// });

// const addFXHelper = async (colRef) => {
//   const querySnapshot = await colRef.get();
//   const ps = [];
//   for (const queryDocSnapshot of querySnapshot.docs) {
//     const speed = queryDocSnapshot.get("speed");
//     const assetId = speed.assetId;
//     if (assetId !== 0) {
//       console.log(assetId, queryDocSnapshot.ref.path);
//       continue;
//     }
//     const p = queryDocSnapshot.ref.update({FX: 1});
//     ps.push(p);
//   }
//   return Promise.all(ps);
// }
// exports.addFX = functions.https.onCall(async (data, context) => {
//   const usersColRef = db.collection("users");
//   const querySnapshot = await usersColRef.get();
//   const ps = [];
//   for (const queryDocSnapshot of querySnapshot.docs) {
//     const bidOutsColRef = queryDocSnapshot.ref.collection("bidOuts");
//     const p = addFXHelper(bidOutsColRef);
//     ps.push(p);

//     const bidInsPublicColRef = queryDocSnapshot.ref.collection("bidInsPublic");
//     const p2 = addFXHelper(bidInsPublicColRef);
//     ps.push(p2);
//   }
//   return Promise.all(ps);
// });

// exports.addHeartbeat = functions.https.onCall(async (data, context) => {
//   const usersColRef = db.collection("users");
//   const querySnapshot = await usersColRef.get();
//   for (const queryDocSnapshot of querySnapshot.docs) {
//     const heartbeat = queryDocSnapshot.get("heartbeat");
//     if (heartbeat) continue;
//     await queryDocSnapshot.ref.update({"heartbeat": 0});
//   }
// });

// exports.changeHeartbeat = functions.https.onCall(async (data, context) => {
//   const usersColRef = db.collection("users");
//   const querySnapshot = await usersColRef.get();
//   const ps = [];
//   for (const queryDocSnapshot of querySnapshot.docs) {
//     // console.log(queryDocSnapshot.id);
//     // const heartbeatForeground = queryDocSnapshot.get("heartbeatForeground");
//     // const heartbeatBackground = queryDocSnapshot.get("heartbeatBackground");
//     // console.log('heartbeatForeground', heartbeatForeground);
//     // console.log('heartbeatBackground', heartbeatBackground);
//     // if (heartbeatForeground && heartbeatBackground) continue;
//     const heartbeat = queryDocSnapshot.get("heartbeat");
//     // console.log('heartbeat', heartbeat);
//     if (!heartbeat) continue;
//     const p = queryDocSnapshot.ref.update({"heartbeat": FieldValue.delete(), "heartbeatForeground": heartbeat, "heartbeatBackground": heartbeat});
//     ps.push(p);
//   }
//   return Promise.all(ps);
// });

// exports.usersWithBadStructure = functions.https.onCall(async (data, context) => {
//   const usersColRef = db.collection("users");
//   const querySnapshot = await usersColRef.get();
//   for (const queryDocSnapshot of querySnapshot.docs) {
//     const missingField = queryDocSnapshot.get("rating");
//     if (!missingField) console.log(queryDocSnapshot.id);
//   }
//   console.log("end");
// });

// exports.addImageUrl = functions.https.onCall(async (data, context) => {
//   const usersColRef = db.collection("users");
//   const querySnapshot = await usersColRef.get();
//   for (const queryDocSnapshot of querySnapshot.docs) {
//     const imageUrl = queryDocSnapshot.get("imageUrl");
//     if (imageUrl) continue;
//     // if (queryDocSnapshot.id === "JKeoaTdK0TPcubowLmeNEBXbwI72") {
//     //   console.log(imageUrl);
//     //   if (imageUrl) continue;
//     //   console.log("STRANGE");
//     // }
//     // console.log(queryDocSnapshot.id);
//     // console.log(imageUrl);
//     await queryDocSnapshot.ref.update({"imageUrl": null});
//   }
//   console.log("end");
// });

// exports.addSocialLinks = functions.https.onCall(async (data, context) => {
//   const usersColRef = db.collection("users");
//   const querySnapshot = await usersColRef.get();
//   for (const queryDocSnapshot of querySnapshot.docs) {
//     const socialLinks = queryDocSnapshot.get("socialLinks");
//     if (socialLinks) continue;
//     // if (queryDocSnapshot.id === "JKeoaTdK0TPcubowLmeNEBXbwI72") {
//     //   console.log(imageUrl);
//     //   if (imageUrl) continue;
//     //   console.log("STRANGE");
//     // }
//     console.log(queryDocSnapshot.id);
//     // console.log(imageUrl);
//     await queryDocSnapshot.ref.update({"socialLinks": []});
//   }
//   console.log("end");
// });

// TODO not finished yet
// exports.changeAlgorandAccountsDoc = functions.https.onCall(async (data, context) => {
//   const usersColRef = db.collection("users");
//   const querySnapshot = await usersColRef.get();
//   const ps = [];
//   for (const queryDocSnapshot of querySnapshot.docs) {

//     queryDocSnapshot.ref.collection("algorand_accounts")

//     // console.log(queryDocSnapshot.id);
//     // const heartbeatForeground = queryDocSnapshot.get("heartbeatForeground");
//     // const heartbeatBackground = queryDocSnapshot.get("heartbeatBackground");
//     // console.log('heartbeatForeground', heartbeatForeground);
//     // console.log('heartbeatBackground', heartbeatBackground);
//     // if (heartbeatForeground && heartbeatBackground) continue;
//     const heartbeat = queryDocSnapshot.get("heartbeat");
//     // console.log('heartbeat', heartbeat);
//     if (!heartbeat) continue;
//     const p = queryDocSnapshot.ref.update({"heartbeat": FieldValue.delete(), "heartbeatForeground": heartbeat, "heartbeatBackground": heartbeat});
//     ps.push(p);
//   }
//   return Promise.all(ps);
// });

// exports.checkForOldRules = functions.https.onCall(async (data, context) => {
//   const usersColRef = db.collection("users");
//   const querySnapshot = await usersColRef.get();
//   for (const queryDocSnapshot of querySnapshot.docs) {

//     const rule = queryDocSnapshot.get("rule");
//     const c = rule.importance.chrony;
//     const h = rule.importance.highroller;

//     if (c !== 1 && h !== 1) {
//       console.log(`${queryDocSnapshot.id} ${c} ${h}`);
//     }
//   }
// });

// exports.addUrl = functions.https.onCall(async (data, context) => {
//   const usersColRef = db.collection("users");
//   const querySnapshot = await usersColRef.get();
//   for (const queryDocSnapshot of querySnapshot.docs) {
//     const url = queryDocSnapshot.get("url");
//     if (url || url === null) continue;
//     console.log(queryDocSnapshot.id);
//     // console.log(url);
//     // await queryDocSnapshot.ref.update({"url": null});
//   }
//   console.log("end");
// });

// TEST

// exports.updateTopTEST = functions.runWith(runWithObj).https.onCall(async (data, context) => {
//   const meetingId = "5dCYzQysjmal7HatShZ3";
//   const doc = await db.collection("meetings").doc(meetingId).get();
//   const meeting = doc.data();

//   // meeting.FX = 1;
//   // meeting.speed = {assetId: 0, num: 1};
//   // meeting.duration = 7;

//   return updateTopValues(meetingId, meeting);
//   // return updateTopSpeeds(meetingId, meeting);
//   // return updateTopDurations(meetingId, meeting);
// });

// test({})
// exports.test = functions.https.onCall(async (data, context) => {
//   const speed = {assetId: 23};
//   const note = "WDl6bHZvWWlGa2hNVzQ2dVVwYlQuMS43NTMxMzc3MTk=";
//   const txType = speed.assetId === 0 ? "pay" : "axfer";
//   const lookup = await algorandIndexer.lookupAccountTransactions(process.env.ALGORAND_SYSTEM_ACCOUNT).notePrefix(note).minRound(process.env.ALGORAND_MIN_ROUND).do();
//   // const lookup = await algorandIndexer.lookupAccountTransactions(process.env.ALGORAND_SYSTEM_ACCOUNT).txType(txType).assetID(speed.assetId).notePrefix(note).minRound(process.env.ALGORAND_MIN_ROUND).do();
//   console.log("lookup.transactions.length", lookup.transactions.length);
// });

// STATS

// exports.docsPerCollecltion = functions.https.onCall(async (data, context) => {
//   const colRefs = await db.listCollections();
//   colRefs.forEach(async (colRef) => {
//     const q = await colRef.get();
//     const s = q.size;
//     console.log(`${colRef.id} - ${s}`);
//   });
// });
