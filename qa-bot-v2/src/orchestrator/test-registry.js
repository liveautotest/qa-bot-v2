const { runLoginTest } = require("../tests/login.test");
const { runLogoutTest } = require("../tests/logout.test");
const { runFlexibleSearchTest, runSearchTest } = require("../tests/search.test");
const { runContractRequestTest } = require("../tests/contract-request.test");

const registry = {
  login: runLoginTest,
  logout: runLogoutTest,
  search: runSearchTest,
  "search-flexible": runFlexibleSearchTest,
  "contract-request": runContractRequestTest
};

function getTest(name) {
  return registry[name];
}

module.exports = {
  getTest
};
