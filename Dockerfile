# docker run --name app_builder --rm -i -t debian bash
# docker run --name 4134a2aa81ea --rm -i -t 4134a2aa81ea bash
# docker tag 8fb647540d62 gcr.io/i2i-test/cloudbuild

FROM node:16

# install firebase
RUN npm install -g firebase-tools

# install lint
# RUN npm install -g eslint
# RUN npm install -g eslint-config-google

ADD firebase.bash /usr/bin
RUN chmod +x /usr/bin/firebase.bash
ENTRYPOINT [ "/usr/bin/firebase.bash" ]
