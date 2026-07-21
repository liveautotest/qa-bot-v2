const { runLoginTest } = require("../tests/login.test");
const { runLogoutTest } = require("../tests/logout.test");

const registry = {
  login: runLoginTest,
  logout: runLogoutTest
};

function getTest(name) {
  return registry[name];
}

module.exports = {
  getTest
};
