# docker run --name app_builder --rm -i -t debian bash
# docker run --name 4134a2aa81ea --rm -i -t 4134a2aa81ea bash
# docker tag 8fb647540d62x gcr.io/i2i-test/cloudbuild

# gcloud config set project app-2i2i
# gcloud config set project i2i-test
# gcloud builds submit . -t gcr.io/i2i-test/functions_cloudbuild
# gcloud builds submit . -t gcr.io/app-2i2i/functions_cloudbuild

FROM node:16

# install firebase
RUN npm install -g firebase-tools

# install lint
# RUN npm install -g eslint
# RUN npm install -g eslint-config-google

ADD firebase.bash /usr/bin
RUN chmod +x /usr/bin/firebase.bash
ENTRYPOINT [ "/usr/bin/firebase.bash" ]
