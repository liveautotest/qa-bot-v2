const { runLoginTest } = require("../tests/login.test");
const { runLogoutTest } = require("../tests/logout.test");
const { runSearchTest } = require("../tests/search.test");

const registry = {
  login: runLoginTest,
  logout: runLogoutTest,
  search: runSearchTest
};

function getTest(name) {
  return registry[name];
}

module.exports = {
  getTest
};
