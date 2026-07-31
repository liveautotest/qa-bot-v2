const fs = require("fs");
const path = require("path");
const {
  dumpUi,
  runAdb,
  screenshotPng,
  tap
} = require("../../infra/adb");

function parseBounds(bounds) {
  const match = String(bounds || "").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!match) return null;
  const [, left, top, right, bottom] = match.map(Number);
  return {
    left,
    top,
    right,
    bottom,
    x: Math.round((left + right) / 2),
    y: Math.round((top + bottom) / 2)
  };
}

function decodeXmlValue(value) {
  return String(value || "")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#10;/g, "\n");
}

function parseNodes(xml) {
  return (xml.match(/<node\b[^>]*>/g) || []).map((raw) => {
    const attrs = {};
    for (const match of raw.matchAll(/([\w:-]+)="([^"]*)"/g)) {
      attrs[match[1]] = decodeXmlValue(match[2]);
    }
    return { attrs, bounds: parseBounds(attrs.bounds) };
  });
}

function nodeLabel(node) {
  return [
    node.attrs.text || "",
    node.attrs["content-desc"] || "",
    node.attrs.hint || ""
  ].join("\n");
}

function xmlTextLines(xml) {
  return parseNodes(xml)
    .map(nodeLabel)
    .flatMap((label) => label.split("\n"))
    .map((line) => line.trim())
    .filter(Boolean);
}

function isVisibleNode(node) {
  if (!node?.bounds) return false;
  return node.bounds.bottom > 120 && node.bounds.top < 2449 && node.bounds.bottom > node.bounds.top;
}

function findNode(xml, labels, options = {}) {
  const labelList = Array.isArray(labels) ? labels : [labels];
  const nodes = parseNodes(xml).filter((node) => {
    if (!node.bounds) return false;
    if (options.visible && !isVisibleNode(node)) return false;
    if (options.clickable && node.attrs.clickable !== "true") return false;
    if (options.enabled && node.attrs.enabled !== "true") return false;
    const label = nodeLabel(node);
    return labelList.some((value) => label.includes(value));
  });
  return nodes.find((node) => node.attrs.clickable === "true") || nodes[0];
}

function findExactNode(xml, labels, options = {}) {
  const labelList = Array.isArray(labels) ? labels : [labels];
  const nodes = parseNodes(xml).filter((node) => {
    if (!node.bounds) return false;
    if (options.visible && !isVisibleNode(node)) return false;
    if (options.clickable && node.attrs.clickable !== "true") return false;
    if (options.enabled && node.attrs.enabled !== "true") return false;
    const label = nodeLabel(node).trim();
    return labelList.includes(label);
  });
  return nodes.find((node) => node.attrs.clickable === "true") || nodes[0];
}

function saveXml(store, name, xml) {
  const filePath = path.join(store.logsDir, `${name}.xml`);
  fs.writeFileSync(filePath, xml || "");
  return filePath;
}

function isInvalidUiDump(xml) {
  return (
    !xml ||
    xml.includes("ERROR: could not get idle state") ||
    !xml.includes("<hierarchy")
  );
}

async function dumpUiStable(config, device, attempts = 4) {
  let xml = "";
  for (let count = 0; count < attempts; count += 1) {
    xml = await dumpUi(config, device);
    if (!isInvalidUiDump(xml)) return xml;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return xml;
}

async function saveFailureArtifacts(config, device, store, name, xml) {
  const xmlPath = saveXml(store, name, xml || (await dumpUiStable(config, device)));
  const screenshotPath = path.join(store.screenshotsDir, `${name}.png`);
  fs.writeFileSync(screenshotPath, await screenshotPng(config, device));
  return { xmlPath, screenshotPath };
}

async function waitForUi(config, device, predicate, timeoutMs = 12000) {
  const startedAt = Date.now();
  let xml = "";
  while (Date.now() - startedAt < timeoutMs) {
    xml = await dumpUiStable(config, device);
    if (predicate(xml)) return xml;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return xml;
}

async function tapNode(config, device, node, label, steps) {
  if (!node?.bounds) {
    const error = new Error(`${label}을 찾지 못했습니다.`);
    error.steps = steps;
    throw error;
  }
  await tap(config, device, node.bounds.x, node.bounds.y);
}

async function tapButtonAndWaitFast(config, device, node, predicate, label, options = {}) {
  if (!node?.bounds) return "";

  const attempts = options.attempts || [
    { x: node.bounds.x, y: node.bounds.y, waitMs: 1800, type: "tap" },
    { x: node.bounds.x, y: node.bounds.y, waitMs: 2200, type: "tap" },
    { x: node.bounds.x, y: Math.max(node.bounds.top + 12, node.bounds.y - 24), waitMs: 2500, type: "tap" }
  ];

  let xml = "";
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    if (attempt.type === "press") {
      await runAdb(config, device, [
        "shell",
        "input",
        "swipe",
        String(attempt.x),
        String(attempt.y),
        String(attempt.x),
        String(attempt.y),
        String(attempt.durationMs || 120)
      ]);
    } else {
      await tap(config, device, attempt.x, attempt.y);
    }
    xml = await waitForUi(config, device, predicate, attempt.waitMs);
    if (predicate(xml)) return xml;
  }

  return xml;
}

module.exports = {
  dumpUiStable,
  findExactNode,
  findNode,
  isVisibleNode,
  nodeLabel,
  parseNodes,
  saveFailureArtifacts,
  saveXml,
  tapButtonAndWaitFast,
  tapNode,
  waitForUi,
  xmlTextLines
};
