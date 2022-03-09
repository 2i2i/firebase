#!/bin/bash

# npm --prefix functions run lint

cd functions
npm install
cd ..

# run the original firebase
if [ $FIREBASE_TOKEN ]; then
  firebase "$@" --token $FIREBASE_TOKEN
else
  firebase "$@"
fi
