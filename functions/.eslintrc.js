module.exports = {
  root: true,
  env: {
    es6: true,
    node: true,
  },
  extends: [
    "eslint:recommended",
    "google",
  ],
  rules: {
    "quotes": ["error", "double"],
    "max-len": ["warn", {"code": 80, "ignoreComments": true}],
  },
  parserOptions: {
    "ecmaVersion": 2021,
  },
};
