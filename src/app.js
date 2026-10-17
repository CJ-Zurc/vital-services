// Compatibility import: tests and startup must exercise the same API factory.
module.exports = { createApp: require("./index").createApp };
