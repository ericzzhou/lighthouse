/**
 * @license Copyright 2021 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

// dumact

const fs = require('fs');
const jsdom = require('jsdom');
const {serializeArguments} = require('../lighthouse-core/gather/driver/execution-context.js');
const {LH_ROOT} = require('../root.js');

const html = fs.readFileSync(LH_ROOT + '/report/assets/templates.html', 'utf-8');
const {window} = new jsdom.JSDOM(html);
const tmplEls = window.document.querySelectorAll('template');

/**
 * @param {string} str
 */
function upperFirst(str) {
  return str.charAt(0).toUpperCase() + str.substr(1);
}

/**
 * @param {string} functionName
 * @param {string[]} bodyLines
 * @param {string[]} parameterNames
 */
function createFunctionCode(functionName, bodyLines, parameterNames = []) {
  const body = bodyLines.map(l => `  ${l}`).join('\n');
  const functionCode = `function ${functionName}(${parameterNames.join(', ')}) {\n${body}\n}`;
  return functionCode;
}

/**
 * @param {HTMLTemplateElement} tmpEl
 */
function compileTemplate(tmpEl) {
  const elemToVarNames = new Map();
  const lines = [];

  /**
   * @param {Element} el
   * @return {string}
   */
  function makeOrGetVarName(el) {
    const varName = elemToVarNames.get(el) || ('v' + elemToVarNames.size);
    elemToVarNames.set(el, varName);
    return varName;
  }

  /**
   * @param {Element} el
   */
  function process(el) {
    const isSvg = el.namespaceURI && el.namespaceURI.endsWith('/svg');
    const namespaceURI = isSvg ? el.namespaceURI : '';
    const tagName = el.localName;
    const className = el.classList.toString();

    let createElementFnName = 'createElement';
    const args = [tagName];
    if (className) {
      args.push(className);
    }
    if (namespaceURI) {
      createElementFnName = 'createElementNS';
      args.unshift(namespaceURI);
    }

    const varName = makeOrGetVarName(el);
    lines.push(`const ${varName} = dom.${createElementFnName}(${serializeArguments(args)});`);

    if (el.getAttributeNames) {
      for (const attr of el.getAttributeNames() || []) {
        if (attr === 'class') continue;

        lines.push(`${varName}.setAttribute('${attr}', '${el.getAttribute(attr)}');`);
      }
    }

    /** @type {string[]} */
    const childNodesToAppend = [];
    for (const childNode of el.childNodes) {
      if (childNode.nodeType === window.Node.COMMENT_NODE) continue;

      if (childNode.nodeType === window.Node.TEXT_NODE) {
        if (!childNode.parentElement) continue;
        if (!childNode.textContent) continue;

        // Most all-whitespace nodes can be ignored
        // (example: the first and last nodes are typically text nodes of newlines and spaces),
        // but not all can. Sometimes spaces are important for content (ex: lh-generated).
        // As an heurstic, check if a text node has two sibling element nodes and that at least
        // one is a span. This results in correct content with minimal false positives (which just means
        // a few extra text node creations).
        const previousSiblingElement = childNode.previousSibling &&
          childNode.previousSibling.nodeType === window.Node.ELEMENT_NODE ?
          /** @type {HTMLElement} */ (childNode.previousSibling) :
          null;
        const nextSiblingElement = childNode.nextSibling &&
          childNode.nextSibling.nodeType === window.Node.ELEMENT_NODE ?
          /** @type {HTMLElement} */ (childNode.nextSibling) :
          null;
        const allowJustWhitespace = previousSiblingElement && nextSiblingElement &&
          (previousSiblingElement.tagName === 'SPAN' || nextSiblingElement.tagName === 'SPAN');
        if (!allowJustWhitespace && !childNode.textContent.trim()) {
          continue;
        }

        let textContent = childNode.textContent;
        // Consecutive whitespace is redundant, unless in certain elements.
        if (!['PRE', 'STYLE'].includes(childNode.parentElement.tagName)) {
          textContent = textContent.replace(/\s+/g, ' ');
        }
        // Escaped string value for JS.
        textContent = JSON.stringify(textContent);

        childNodesToAppend.push(textContent);
        continue;
      }

      // @ts-expect-error: it's an Element.
      process(childNode);

      const childVarName = elemToVarNames.get(childNode);
      if (childVarName) childNodesToAppend.push(childVarName);
    }

    if (childNodesToAppend.length) {
      lines.push(`${varName}.append(${childNodesToAppend.join(',')});`);
    }
  }

  const fragmentVarName = makeOrGetVarName(tmpEl);
  lines.push(`const ${fragmentVarName} = dom.document().createDocumentFragment();`);

  for (const topLevelEl of tmpEl.content.children) {
    process(topLevelEl);
    lines.push(`${fragmentVarName}.append(${makeOrGetVarName(topLevelEl)});`);
  }

  lines.push(`return ${fragmentVarName};`);

  const componentName = tmpEl.id;
  const functionName = `create${upperFirst(componentName)}Component`;
  const jsdoc = `
/**
 * @param {DOM} dom
 */`;
  const functionCode = jsdoc + '\n' + createFunctionCode(functionName, lines, ['dom']);
  return {tmpEl, componentName, functionName, functionCode};
}

function makeGenericCreateComponentFunctionCode(processedTemplates) {
  const lines = [];

  lines.push('switch (componentName) {');
  for (const {componentName, functionName} of processedTemplates) {
    lines.push(`  case '${componentName}': return ${functionName}(dom);`);
  }
  lines.push('}');
  lines.push('throw new Error(\'unexpected component: \' + componentName)');

  const paramType = processedTemplates.map(t => `'${t.componentName}'`).join('|');
  const jsdoc = `
/** @typedef {${paramType}} ComponentName */
/**
 * @param {DOM} dom
 * @param {ComponentName} componentName
 * @return {DocumentFragment}
 */`;
  return jsdoc + '\nexport ' +
    createFunctionCode('createComponent', lines, ['dom', 'componentName']);
}

async function main() {
  const processedTemplates = [...tmplEls].map(compileTemplate);
  processedTemplates.sort((a, b) => a.componentName.localeCompare(b.componentName));
  const code = `
    'use strict';

    // auto-generated by build/build-report-components.js

    /** @typedef {import('./dom.js').DOM} DOM */

    /* eslint-disable max-len */

    ${processedTemplates.map(t => t.functionCode).join('\n')}

    ${makeGenericCreateComponentFunctionCode(processedTemplates)}
  `.trim();
  fs.writeFileSync(LH_ROOT + '/report/renderer/components.js', code);
}

main();
