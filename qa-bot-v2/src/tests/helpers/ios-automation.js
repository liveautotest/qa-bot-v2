const fs = require("fs");
const path = require("path");
const {
  dumpUiTree,
  screenshotPng,
  tap
} = require("../../infra/ios-wda");

// helpers/ui-automation.js(AOS, XML dump 기반)와 이름/시그니처를 최대한 맞춘
// iOS 버전. WDA의 /source?format=json 트리를 평탄화한 노드 리스트를 다룬다.

function nodeBoundsFromRect(rect) {
  if (!rect) return null;
  const left = rect.x;
  const top = rect.y;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  if (right <= left || bottom <= top) return null;

  return {
    left,
    top,
    right,
    bottom,
    x: Math.round(left + rect.width / 2),
    y: Math.round(top + rect.height / 2)
  };
}

function flattenTree(root, nodes = []) {
  if (!root) return nodes;

  nodes.push({
    attrs: {
      type: root.type || "",
      label: root.label || "",
      name: root.name || "",
      value: root.value != null ? String(root.value) : "",
      enabled: root.isEnabled !== false,
      visible: root.isVisible !== false
    },
    bounds: nodeBoundsFromRect(root.rect)
  });

  for (const child of root.children || []) {
    flattenTree(child, nodes);
  }

  return nodes;
}

function nodeLabel(node) {
  return [node.attrs.label, node.attrs.name, node.attrs.value]
    .filter(Boolean)
    .join("\n");
}

function findNode(nodes, labels, options = {}) {
  const labelList = Array.isArray(labels) ? labels : [labels];
  const matches = nodes.filter((node) => {
    if (!node.bounds) return false;
    if (options.visible && node.attrs.visible === false) return false;
    if (options.enabled && node.attrs.enabled === false) return false;
    return labelList.some((value) => nodeLabel(node).includes(value));
  });
  return matches[0];
}

function findExactNode(nodes, labels, options = {}) {
  const labelList = Array.isArray(labels) ? labels : [labels];
  const matches = nodes.filter((node) => {
    if (!node.bounds) return false;
    if (options.visible && node.attrs.visible === false) return false;
    if (options.enabled && node.attrs.enabled === false) return false;
    return labelList.includes(node.attrs.label) || labelList.includes(node.attrs.name);
  });
  return matches[0];
}

async function dumpNodes(wdaUrl, sessionId) {
  const tree = await dumpUiTree(wdaUrl, sessionId);
  return flattenTree(tree);
}

async function waitForNodes(wdaUrl, sessionId, predicate, timeoutMs = 12000) {
  const startedAt = Date.now();
  let nodes = [];
  while (Date.now() - startedAt < timeoutMs) {
    nodes = await dumpNodes(wdaUrl, sessionId);
    if (predicate(nodes)) return nodes;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return nodes;
}

async function tapNode(wdaUrl, sessionId, node, label, steps) {
  if (!node?.bounds) {
    const error = new Error(`${label}을 찾지 못했습니다.`);
    error.steps = steps;
    throw error;
  }
  await tap(wdaUrl, sessionId, node.bounds.x, node.bounds.y);
}

function saveNodesSnapshot(store, name, nodes) {
  const filePath = path.join(store.logsDir, `${name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(nodes, null, 2));
  return filePath;
}

async function saveFailureArtifacts(wdaUrl, sessionId, store, name, nodes) {
  const jsonPath = saveNodesSnapshot(store, name, nodes || (await dumpNodes(wdaUrl, sessionId)));
  const screenshotPath = path.join(store.screenshotsDir, `${name}.png`);
  fs.writeFileSync(screenshotPath, await screenshotPng(wdaUrl, sessionId));
  return { jsonPath, screenshotPath };
}

module.exports = {
  dumpNodes,
  findExactNode,
  findNode,
  nodeLabel,
  saveFailureArtifacts,
  saveNodesSnapshot,
  tapNode,
  waitForNodes
};
