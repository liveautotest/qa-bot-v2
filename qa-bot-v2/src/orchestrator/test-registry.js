const { runLoginTest } = require("../tests/login.test");
const { runLogoutTest } = require("../tests/logout.test");
const { runFlexibleSearchTest, runSearchTest } = require("../tests/search.test");
const {
  runContractApproveTest,
  runContractRejectTest
} = require("../tests/contract-approve.test");
const {
  runContractCancelConfirmedTest,
  runContractCancelRequestTest
} = require("../tests/contract-cancel-request.test");
const { runContractPaymentTest } = require("../tests/contract-payment.test");
const { runContractRequestTest } = require("../tests/contract-request.test");

const registry = {
  login: runLoginTest,
  logout: runLogoutTest,
  search: runSearchTest,
  "search-flexible": runFlexibleSearchTest,
  "contract-approve": runContractApproveTest,
  "contract-reject": runContractRejectTest,
  "contract-cancel-confirmed": runContractCancelConfirmedTest,
  "contract-cancel-request": runContractCancelRequestTest,
  "contract-payment": runContractPaymentTest,
  "contract-request": runContractRequestTest
};

function getTest(name) {
  return registry[name];
}

module.exports = {
  getTest
};
