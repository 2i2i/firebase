#!/bin/bash

# npm --prefix functions run lint

# run the original firebase
if [ $FIREBASE_TOKEN ]; then
  firebase "$@" --token $FIREBASE_TOKEN
else
  firebase "$@"
fi
