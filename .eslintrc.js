module.exports = {
    "env": {
        "es6": false,
        "node": true
    },
    "extends": "eslint:recommended",
    "parserOptions": {
        "sourceType": "module"
    },
    "rules": {
        "indent": [2, 2, { "SwitchCase": 1 }],
        "linebreak-style": [2, "unix"],
        "quotes": [2, "single"],
        "semi": [2, "always"]
    }
};