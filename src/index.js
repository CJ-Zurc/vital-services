const { port } = require("./config");
const { createApp } = require("./app");

createApp().listen(port, () => {
  console.log(`vital-services listening on ${port}`);
});
