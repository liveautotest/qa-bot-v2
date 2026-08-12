const { runLoginTest } = require("../tests/login.test");
const { runLogoutTest } = require("../tests/logout.test");
const { runFlexibleSearchTest, runSearchTest } = require("../tests/search.test");
const {
  runContractApproveTest,
  runContractRejectTest
} = require("../tests/contract-approve.test");
const { runContractExtensionApproveTest } = require("../tests/contract-extension-approve.test");
const {
  runContractCancelConfirmedTest,
  runContractCancelRequestTest
} = require("../tests/contract-cancel-request.test");
const { runContractPaymentTest } = require("../tests/contract-payment.test");
const { runContractExtensionTest } = require("../tests/contract-extension.test");
const { runContractRequestTest } = require("../tests/contract-request.test");
const { runTossDepositApproveTest } = require("../tests/toss-deposit-approve.test");
const { runConsoleScheduleChangeTest } = require("../tests/console-schedule-change.test");
const { runReviewProfileTest } = require("../tests/review-profile.test");
const { runReviewScheduleSelectTest } = require("../tests/review-schedule-select.test");
const { runReviewDetailTest } = require("../tests/review-detail.test");
const { runReviewDeleteTest } = require("../tests/review-delete.test");
const { runCouponBoxTest } = require("../tests/coupon-box.test");
const { runReviewEditTest } = require("../tests/review-edit.test");
const { runReviewWriteTest } = require("../tests/review-write.test");

const registry = {
  login: runLoginTest,
  logout: runLogoutTest,
  search: runSearchTest,
  "search-flexible": runFlexibleSearchTest,
  "contract-approve": runContractApproveTest,
  "contract-reject": runContractRejectTest,
  "contract-cancel-confirmed": runContractCancelConfirmedTest,
  "contract-cancel-request": runContractCancelRequestTest,
  "contract-extension": runContractExtensionTest,
  "contract-extension-approve": runContractExtensionApproveTest,
  "contract-payment": runContractPaymentTest,
  "contract-request": runContractRequestTest,
  "toss-deposit-approve": runTossDepositApproveTest,
  "console-schedule-change": runConsoleScheduleChangeTest,
  "review-detail": runReviewDetailTest,
  "review-delete": runReviewDeleteTest,
  "review-profile": runReviewProfileTest,
  "review-schedule-select": runReviewScheduleSelectTest,
  "coupon-box": runCouponBoxTest,
  "review-edit": runReviewEditTest,
  "review-write": runReviewWriteTest
};

function getTest(name) {
  return registry[name];
}

module.exports = {
  getTest
};
