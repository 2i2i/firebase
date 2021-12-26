// firebase use
// firebase functions:shell
// firebase deploy --only functions:ratingAdded
// ./functions/node_modules/eslint/bin/eslint.js functions --fix
// addBid({B:"hTL94lXgZyRiitgCtwYAJxd2BDE3",speed:{num:4, assetID: 0},net:"testnet",addrA:"addrA"})
// acceptBid({bid: "ySVM4xCBYssGRImtgzZn", addrB: "addrB"})
// meetingPaid({meeting: '1JhGOJs2e9uvsr6UWcuA'})
// endMeeting({meeting: 'i6rP2VTQhkL9zv9P2b5V', endReason: 'TEST'})

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

// const MIN_TXN_FEE = 1000;
const NOVALUE_ASSET_ID = 29147319;
const SYSTEM_ID = 32969536;
// const SYSTEM_ACCOUNT = 'WUTGDFVYFLD7VMPDWOO2KOU2YCKIL4OSY43XSV4SBSDIXCRXIPOHUBBLOI';
const CREATOR_PRIVATE_KEY = "during cost olympic enter remind stage satisfy position dance afraid gym two weird dignity garlic myself alien page sunset waste donate mouse project about soup";
const MIN_INSTANCES = 1;

exports.userCreated = functions.runWith({minInstances: MIN_INSTANCES}).auth.user().onCreate((user) => {
  const docRefUser = db.collection("users").doc(user.uid);
  const createUserFuture = docRefUser.create({
    status: "ONLINE",
    locked: false,
    currentMeeting: null,
    bio: "",
    name: "",
    rating: 1,
    numRatings: 0,
    heartbeat: 0,
    tags: [],
  });
  const createUserPrivateFuture = docRefUser.collection("private").doc("main").create({
    blocked: [],
    friends: [],
  });
  return Promise.all([createUserFuture, createUserPrivateFuture]);
});

exports.acceptBid = functions.runWith({minInstances: MIN_INSTANCES}).https.onCall(async (data, context) => {
  const time = Math.floor(new Date().getTime() / 1000);

  console.log("data", data);
  const uid = context.auth.uid;
  const bidB = uid;
  console.log("uid", uid);

  const users = db.collection("users");
  const docRefBidIn = users.doc(uid).collection("bidIns").doc(data.bid);
  const docRefBidInPrivate = docRefBidIn.collection("private").doc("main");
  console.log("starting tx");

  // TODO performance: use parallels promises
  return db.runTransaction(async (T) => {
    const docBidInFuture = T.get(docRefBidIn);
    const docBidInPrivateFuture = T.get(docRefBidInPrivate);
    const docBidReults = await Promise.all([docBidInFuture, docBidInPrivateFuture]);
    const docBidIn = docBidReults[0];
    const docBidInPrivate = docBidReults[1];

    const bidInSpeed = docBidIn.get("speed");
    const bidInNet = docBidIn.get("net");
    const budget = bidInSpeed.num === 0 ? 0 : null;

    const bidA = docBidInPrivate.get("A");
    const docRefBidOut = users.doc(bidA).collection("bidOuts").doc(data.bid);
    const docBidOut = await T.get(docRefBidOut);
    const bidOutSpeed = docBidOut.get("speed");
    const bidOutNet = docBidOut.get("net");
    const bidOutB = docBidOut.get("B");

    console.log("docBidIn", docBidIn.data());
    console.log("docBidInPrivate", docBidInPrivate.data());
    console.log("docBidOut", docBidOut.data());

    // check vs bidOut
    if (bidB !== bidOutB || bidInNet !== bidOutNet || bidInSpeed.assetId !== bidOutSpeed.assetId || bidInSpeed.num !== bidOutSpeed.num) throw Error("failed to match bidOut");

    // check that bidA and bidB are not locked
    const docRefA = users.doc(bidA);
    const docRefB = users.doc(bidB);
    const docAFuture = T.get(docRefA);
    const docBFuture = T.get(docRefB);
    const docABResults = await Promise.all([docAFuture, docBFuture]);
    const docA = docABResults[0];
    const docB = docABResults[1];
    const lockedA = docA.get("locked");
    const lockedB = docB.get("locked");
    console.log("lockedA", lockedA);
    console.log("lockedB", lockedB);
    if (lockedA === true) throw Error("A.locked === true");
    if (lockedB === true) throw Error("B.locked === true");

    // create meeting
    const docRefMeeting = db.collection("meetings").doc();
    const dataMeeting = {
      isActive: true,
      isSettled: false,
      A: bidA,
      B: bidB,
      addrA: docBidInPrivate.get("addrA"),
      addrB: data.addrB,
      budget: budget,
      duration: null,
      txns: {
        group: null,
        lockALGO: null,
        lockASA: null,
        state: null,
        unlock: null,
        optIn: null,
      },
      status: "INIT",
      statusHistory: [{value: "INIT", ts: time}],
      net: bidInNet,
      speed: bidInSpeed,
      bid: data.bid,
      room: null,
      coinFlowsA: [],
      coinFlowsB: [],
    };
    T.create(docRefMeeting, dataMeeting);

    // lock
    T.update(docRefA, {
      locked: true,
      currentMeeting: docRefMeeting.id,
    });
    T.update(docRefB, {
      locked: true,
      currentMeeting: docRefMeeting.id,
    });

    // bids are not active anymore
    T.update(docRefBidIn, {active: false});
    T.update(docRefBidOut, {active: false});
  });
});

// every minute
exports.checkUserStatus = functions.pubsub.schedule("* * * * *").onRun(async (context) => {
  const now = Math.floor(new Date().getTime() / 1000);
  const usersColRef = db.collection("users");
  const queryRef = usersColRef.where("status", "==", "ONLINE").where("heartbeat", "<", now - 10);
  const querySnapshot = await queryRef.get();
  console.log("querySnapshot.size", querySnapshot.size);
  const promises = [];
  querySnapshot.forEach(async (queryDocSnapshotUser) => {
    const p = queryDocSnapshotUser.ref.update({status: "OFFLINE"});
    promises.push(p);
  });
  await Promise.all(promises);
});

exports.endMeeting = functions.runWith({minInstances: MIN_INSTANCES}).https.onCall(async (data, context) => {
  const time = Math.floor(new Date().getTime() / 1000);
  console.log("endMeeting, data, time", data, time);

  const meetingId = data.meetingId;
  const docRefMeeting = db.collection("meetings").doc(meetingId);

  if (data.reason !== "TIMER" 
    && data.reason !== "A"
    && data.reason !== "B"
    && data.reason !== "TXN_FAILED"
    && data.reason !== "DISCONNECT_A"
    && data.reason !== "DISCONNECT_B"
    && data.reason !== "DISCONNECT_AB") return 0;

  return db.runTransaction(async (T) => {
    const docMeeting = await T.get(docRefMeeting);

    // only A xor B can endMeeting
    const A = docMeeting.get("A");
    const B = docMeeting.get("B");
    if (A !== context.auth.uid && B !== context.auth.uid) return 0;


    const status = docMeeting.get("status");
    const statusList = docMeeting.get("status");
    console.log("endMeeting, meetingId, status", meetingId, status);

    if (status.startsWith("END_")) return 0;
    if (data.reason === "TIMER" && status !== "INIT" && status !== "TXN_CREATED" && status !== "CALL_STARTED") return 0; // timer only applies with certain status
    if (data.reason === "A" && (A !== context.auth.uid || (status !== "INIT" && status !== "CALL_STARTED"))) return 0;
    if (data.reason === "B" && (B !== context.auth.uid || (status !== "INIT" && status !== "CALL_STARTED"))) return 0;
    if (data.reason === "TXN_FAILED" && status !== "TXN_SENT") return 0;

    // newStatus
    const newStatus = `END_${data.reason}`;
    const appendToStatusHistory = {value: newStatus, ts: time};

    // update meeting
    const meetingUpdateDoc = {
      status: newStatus,
      statusHistory: admin.firestore.FieldValue.arrayUnion(appendToStatusHistory),
    };
    T.update(docMeeting.ref, meetingUpdateDoc);

    // unlock users
    const docRefA = db.collection("users").doc(A);
    const docRefB = db.collection("users").doc(B);
    T.update(docRefA, {currentMeeting: null, locked: false});
    T.update(docRefB, {currentMeeting: null, locked: false});
  });
});

exports.ratingAdded = functions.runWith({minInstances: MIN_INSTANCES}).firestore
    .document("users/{userId}/ratings/{ratingId}")
    .onCreate((change, context) => {
      const meetingRating = change.get("rating");
      const userId = context.params.userId;
      return db.runTransaction(async (T) => {
        const docRefUser = db.collection("users").doc(userId);
        const docUser = await docRefUser.get();
        const numRatings = docUser.numRatings ?? 0;
        const userRating = docUser.rating ?? 1;
        const newNumRatings = numRatings + 1;
        const newRating = (userRating * numRatings + meetingRating) / newNumRatings; // works for numRatings == 0
        await docRefUser.update({
          rating: newRating,
          numRatings: newNumRatings,
        });
      });
    });

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

exports.giftALGO = functions.runWith({minInstances: MIN_INSTANCES}).https.onCall(async (data, context) => {
  const creatorAccount = algosdk.mnemonicToSecretKey(CREATOR_PRIVATE_KEY);
  console.log("creatorAccount.addr", creatorAccount.addr);

  const userAccount = {addr: data.account};
  console.log("data.account", data.account);

  return sendALGO(clientTESTNET,
      creatorAccount,
      userAccount,
      1000000);
});

exports.giftASA = functions.runWith({minInstances: MIN_INSTANCES}).https.onCall(async (data, context) => {
  const creatorAccount = algosdk.mnemonicToSecretKey(CREATOR_PRIVATE_KEY);
  console.log("creatorAccount.addr", creatorAccount.addr);

  const userAccount = {addr: data.account};
  console.log("data.account", data.account);

  return sendASA(clientTESTNET,
      creatorAccount,
      userAccount,
      1000,
      NOVALUE_ASSET_ID);
});

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

// const optIn = async (client, account, assetIndex) =>
//   sendASA(client, account, account, 0, assetIndex);

const sendASA = async (client, fromAccount, toAccount, amount, assetIndex) => {
  // txn
  const suggestedParams = await client.getTransactionParams().do();
  const transactionOptions = {
    from: fromAccount.addr,
    to: toAccount.addr,
    assetIndex,
    amount,
    suggestedParams,
  };
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject(
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

// TODO could check that transaction really pending and is the correct one
exports.meetingLockCoinsStarted = functions.runWith({minInstances: MIN_INSTANCES}).https.onCall(async (data, context) => {
  const time = Math.floor(new Date().getTime() / 1000);

  console.log("meetingLockCoinsStarted, data", data);
  const docRefMeeting = db.collection("meetings").doc(data.meetingId);

  return db.runTransaction(async (T) => {
    const docMeeting = await T.get(docRefMeeting);

    const statusList = docMeeting.get("status");
    const status = statusList[statusList.length - 1].value;
    console.log("meetingLockCoinsStarted, status", status);
    if (status !== "INIT") return 0;

    const A = docMeeting.get("A");
    console.log("meetingLockCoinsStarted, A", A);
    if (A !== context.auth.uid) throw Error("A !== context.auth.uid");

    T.update(docRefMeeting, {
      txns: data.txns,
      status: admin.firestore.FieldValue.arrayUnion({value: "LOCK_COINS_STARTED", ts: time}),
    });
  });
});

exports.meetingLockCoinsConfirmed = functions.runWith({minInstances: MIN_INSTANCES}).https.onCall(async (data, context) => {
  const time = Math.floor(new Date().getTime() / 1000);

  console.log("meetingLockCoinsConfirmed, data", data);
  const docRefMeeting = db.collection("meetings").doc(data.meetingId);

  return db.runTransaction(async (T) => {
    const docMeeting = await T.get(docRefMeeting);

    const statusList = docMeeting.get("status");
    const status = statusList[statusList.length - 1].value;
    console.log("meetingLockCoinsConfirmed, status", status);
    if (status !== "LOCK_COINS_STARTED") return 0;

    T.update(docRefMeeting, {
      status: admin.firestore.FieldValue.arrayUnion({value: "LOCK_COINS_CONFIRMED", ts: time}),
      budget: data.budget,
    });
  });
});

exports.meetingRoomCreated = functions.runWith({minInstances: MIN_INSTANCES}).https.onCall(async (data, context) => {
  const time = Math.floor(new Date().getTime() / 1000);

  console.log("meetingRoomCreated, data", data);
  const docRefMeeting = db.collection("meetings").doc(data.meetingId);
  // console.log("meetingRoomCreated, docRefMeeting", docRefMeeting);

  return db.runTransaction(async (T) => {
    const docMeeting = await T.get(docRefMeeting);

    const statusList = docMeeting.get("status");
    const status = statusList[statusList.length - 1].value;
    console.log("meetingRoomCreated, status", status);
    if (status !== "LOCK_COINS_CONFIRMED") return 0;

    const A = docMeeting.get("A");
    console.log("meetingRoomCreated, A", A);
    if (A !== context.auth.uid) throw Error("A !== context.auth.uid");

    console.log("meetingRoomCreated, data.currentRoom", data.currentRoom);
    T.update(docRefMeeting, {
      status: admin.firestore.FieldValue.arrayUnion({value: "ACTIVE", ts: time}),
      currentRoom: data.currentRoom,
    });
  });
});

exports.meetingEnded = functions.runWith({minInstances: MIN_INSTANCES}).firestore
    .document("meetings/{meetingId}")
    .onUpdate((change, context) => {
      const newStatusList = change.after.data().status;
      const newStatus = newStatusList[newStatusList.length - 1].value;
      // is meeting done?
      console.log("meetingEnded, newStatus", newStatus);
      if (!newStatus.startsWith("END_")) return 0;

      const oldStatusList = change.before.data().status;
      const oldStatus = oldStatusList[oldStatusList.length - 1].value;
      // has status changed?
      console.log("meetingEnded, oldStatus", oldStatus);
      if (oldStatus === newStatus) return 0;

      // were coins locked?
      let coinsLocked = false;
      for (const status of newStatusList) {
        if (status.value === "LOCK_COINS_STARTED") {
          coinsLocked = true;
          break;
        }
      }
      console.log("meetingEnded, coinsLocked", coinsLocked);
      if (!coinsLocked) return 0;

      const meetingId = context.params.meetingId;
      const dataMeeting = change.after.data();
      const quantities = calcQuantitiesFromData(dataMeeting);
      console.log("meetingEnded, quantities", quantities);
      const docRefMeeting = db.collection("meetings").doc(meetingId);
      return settleMeeting(docRefMeeting, quantities);
    });

const calcQuantitiesFromData = (data) => {
  const quantities = {
    speed: data.speed,
    duration: 0,
    addrA: data.addrA,
    addrB: data.addrB,
  };

  let activeTime = undefined;
  for (const status of data.status) {
    if (status.value === "ACTIVE") {
      activeTime = status.ts;
      break;
    }
  }
  if (activeTime !== undefined) {
    let endTime = undefined;
    for (const status of data.status) {
      if (status.value.startsWith("END_")) {
        endTime = status.ts;
        break;
      }
    }
    // TODO check and add calc where END_BUDGET written
    console.log("meetingEnded, quantities.speed.num", quantities.speed.num);
    quantities.duration = endTime - activeTime;
    console.log("meetingEnded, quantities.duration", quantities.duration);
  }

  return quantities;
};

const settleMeeting = async (docRef, quantities) => {
  console.log("settleMeeting, quantities", quantities);
  let txId = null;

  console.log("settleMeeting, quantities.speed.num", quantities.speed.num);
  if (quantities.speed.num !== 0) {
    if (quantities.speed.assetId === 0) {
      txId = await settleALGOMeeting(clientTESTNET, quantities);
    } else {
      txId = await settleASAMeeting(clientTESTNET, quantities);
    }
  }

  console.log("settleMeeting, txId", txId);

  // update meeting
  const time = Math.floor(new Date().getTime() / 1000);
  await docRef.update({
    "status": admin.firestore.FieldValue.arrayUnion({value: "SETTLED", ts: time}),
    "txns.unlock": txId,
  });
  console.log("settleMeeting, 3");
};

const settleALGOMeeting = async (
    algodclient,
    quantities,
) => {
  console.log("settleALGOMeeting, quantities", quantities);

  // accounts
  const accountCreator = algosdk.mnemonicToSecretKey(CREATOR_PRIVATE_KEY);
  console.log("settleALGOMeeting, accountCreator.addr", accountCreator.addr);
  const suggestedParams = await algodclient.getTransactionParams().do();
  console.log("settleALGOMeeting, suggestedParams", suggestedParams);

  // state
  const appArg0 = new TextEncoder().encode("UNLOCK");
  const appArg1 = algosdk.encodeUint64(quantities.duration);
  const appArgs = [appArg0, appArg1];
  const stateTxn = algosdk.makeApplicationNoOpTxnFromObject({
    from: accountCreator.addr,
    appIndex: SYSTEM_ID,
    appArgs,
    accounts: [quantities.addrA, quantities.addrB],
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

const settleASAMeeting = async (
    algodclient,
    quantities,
) => {
  console.log("settleASAMeeting, quantities", quantities);

  // accounts
  const accountCreator = algosdk.mnemonicToSecretKey(CREATOR_PRIVATE_KEY);
  console.log("settleASAMeeting, accountCreator.addr", accountCreator.addr);
  const suggestedParams = await algodclient.getTransactionParams().do();
  console.log("settleASAMeeting, suggestedParams", suggestedParams);

  // state
  const appArg0 = new TextEncoder().encode("UNLOCK");
  const appArg1 = algosdk.encodeUint64(quantities.duration);
  const appArgs = [appArg0, appArg1];
  const stateTxn = algosdk.makeApplicationNoOpTxnFromObject({
    from: accountCreator.addr,
    appIndex: SYSTEM_ID,
    appArgs,
    accounts: [quantities.addrA, quantities.addrB],
    foreignAssets: [quantities.speed.assetId],
    suggestedParams,
  });
  console.log("settleASAMeeting, stateTxn");

  // sign
  const stateTxnSigned = stateTxn.signTxn(accountCreator.sk);
  console.log("settleASAMeeting, signed");

  // send
  try {
    const {txId} = await algodclient.sendRawTransaction([stateTxnSigned]).do();
    console.log("settleASAMeeting, sent", txId);

    // confirm
    const timeout = 5;
    await waitForConfirmation(algodclient, txId, timeout);
    console.log("settleASAMeeting, confirmed");

    return txId;
  } catch (e) {
    console.log("error", e);
    throw Error(e);
  }
};

// ONLY USE MANUALLY
// deleteAllAuthUsers({})
// exports.deleteAllAuthUsers = functions.https.onCall(async (data, context) => {
//   const users = await admin.auth().listUsers();
//   return admin.auth().deleteUsers(users.users.map(u => u.uid));
// });

// optInToASA({txId: 'QO47JEGJXGRLUKVQ44CKZXQ2X3C4R3JFT22GCUFABNVIC33BZ4AQ', assetId: 23828034})
exports.optInToASA = functions.runWith({minInstances: MIN_INSTANCES}).https.onCall(async (data, context) => {
  console.log("optInToASA, data", data);
  await waitForConfirmation(clientTESTNET, data.txId, 5);
  console.log("optInToASA, waitForConfirmation done");

  const accountCreator = algosdk.mnemonicToSecretKey(CREATOR_PRIVATE_KEY);

  // txn confirmed
  const suggestedParams = await clientTESTNET.getTransactionParams().do();
  const optInTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject(
      {
        from: accountCreator.addr,
        to: accountCreator.addr,
        assetIndex: data.assetId,
        amount: 0,
        suggestedParams,
      },
  );

  // sign
  const optInTxnSigned = optInTxn.signTxn(accountCreator.sk);
  console.log("optInToASA, signed");

  // send
  try {
    const {txId} = await clientTESTNET.sendRawTransaction([optInTxnSigned]).do();
    console.log("optInToASA, sent", txId);

    // confirm
    const timeout = 5;
    await waitForConfirmation(clientTESTNET, txId, timeout);
    console.log("optInToASA, end waitForConfirmation done");

    return txId;
  } catch (e) {
    console.log("error", e);
    throw Error(e);
  }
});

// Algorand A lock txn failed
// unlock both users
// change meeting status
// meetingTxnFailed({meeting: "yYLWe8MxIiCyueA01GiI"})
exports.meetingTxnFailed = functions.runWith({minInstances: MIN_INSTANCES}).https.onCall(async (data, context) => {
  const time = Math.floor(new Date().getTime() / 1000);
  const docRefMeeting = db.collection("meetings").doc(data.meetingId);

  return db.runTransaction(async (T) => {
    const docMeeting = await T.get(docRefMeeting);

    const statusList = docMeeting.get("status");
    const status = statusList[statusList.length - 1].value;
    if (status !== "INIT") return 0;

    const A = docMeeting.get("A");
    if (A !== context.auth.uid) return 0; // can only be called by A

    const B = docMeeting.get("B");
    const docRefA = db.collection("users").doc(A);
    const docRefB = db.collection("users").doc(B);

    T.update(docRefA, {currentMeeting: null, locked: false});
    T.update(docRefB, {currentMeeting: null, locked: false});
    T.update(docRefMeeting, {
      status: admin.firestore.FieldValue.arrayUnion({value: "ALGORAND_TXN_FAILED", ts: time}),
    });
  });
});

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
