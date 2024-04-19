/* ************************************************************************
* ADOBE CONFIDENTIAL
* ___________________
*
* Copyright 2024 Adobe
* All Rights Reserved.
*
* NOTICE: All information contained herein is, and remains
* the property of Adobe and its suppliers, if any. The intellectual
* and technical concepts contained herein are proprietary to Adobe
* and its suppliers and are protected by all applicable intellectual
* property laws, including trade secret and copyright laws.
* Dissemination of this information or reproduction of this material
* is strictly forbidden unless prior written permission is obtained
* from Adobe.
************************************************************************* */
const parseMarkdown = require('milo-parse-markdown').default;
const { mdast2docx } = require('../node_modules/milo-md2docx/lib/index');
const { getAioLogger } = require('./utils');
const { fetchWithRetry } = require('./sharepoint');

const gbStyleExpression = 'gb-';//graybox style expression. need to revisit if there are any more styles to be considered.
const emptyString = '';
const grayboxStylesRegex = new RegExp('gb-[a-zA-Z0-9,._-]*', 'g');
const gbDomainSuffix = '-graybox';
const logger = getAioLogger();
let firstGtRows = [];


/**
 * Updates a document based on the provided Markdown file path, experience name, and options.
 * @param {string} mdPath - The path to the Markdown file.
 * @param {string} experienceName - The name of the experience.
 * @param {object} options - The options for fetching the Markdown file.
 * @returns {Promise} - A promise that resolves to the generated Docx file.
 */
async function updateDocument(mdPath, expName, options = {}){
    firstGtRows = [];
    const response = await fetchWithRetry(`${mdPath}`, options);
    const content = await response.text();
    if (content.includes(expName) || content.includes(gbStyleExpression) || content.includes(gbDomainSuffix)) {
        const state = { content: { data: content }, log: '' };
        await parseMarkdown(state);
        const { mdast } = state.content;
        updateExperienceNameFromLinks(mdast.children, expName);
        logger.info('Experience name removed from links');
        iterateGtRowsToReplaceStyles();
        logger.info('Graybox styles removed');
        //generated docx file from updated mdast
        const docx = await generateDocxFromMdast(mdast);
        //TODO promote this docx file
        logger.info('Mdast to Docx file conversion done');
    }
}

/**
 * Replace all relative link references in the given mdast with the provided experience name and graybox style pattern.
 * @param {Array} mdast - The mdast to be updated.
 * @param {string} expName - The name of the experience.
 * @param {RegExp} grayboxStylePattern - The pattern to match graybox styles.
 */
const updateExperienceNameFromLinks = (mdast, expName) => {
    if (mdast) {
        mdast.forEach((child) => {
                if (child.type === 'gridTable') {
                    firstGtRows.push(findFirstGtRowInNode(child));
                }
                //remove experience name from links on the document
                if (child.type === 'link' && child.url && (child.url.includes(expName) || child.url.includes(gbDomainSuffix))) {
                    child.url = child.url.replaceAll(`/${expName}/`, '/').replaceAll(gbDomainSuffix, emptyString);
                    logger.info(`Link updated: ${child.url}`);
                }
                if (child.children) {
                    updateExperienceNameFromLinks(child.children, expName);
                }
            }
        );
    }
}

/**
 * Helper function, iterates through the firstGtRows array and replaces graybox styles for each row.
 */
const iterateGtRowsToReplaceStyles = () => {
    firstGtRows.forEach((gtRow) => {
        if (gtRow && gtRow.children) {
            replaceGrayboxStyles(gtRow);
        }
    });
}

/**
 * Replaces all graybox styles from blocks and text.
 * 
 * @param {object} node - The node to process.
 * @returns {void}
 */
const replaceGrayboxStyles = (node) => {
    //replace all graybox styles from blocks and text
    if (node && node.type === 'text' && node.value && node.value.includes(gbStyleExpression)) {
        logger.info(node);
        node.value = node.value.replace(grayboxStylesRegex, emptyString)
            .replace('()', emptyString).replace(', )', ')');
        logger.info('updated value>>  ');
        logger.info(node);
        return;
    }
    if (node.children) {
        node.children.forEach((child) => {
            replaceGrayboxStyles(child);
        });
    }
}

/**
 * Finds the first 'gtRow' node in the given node or its children.
 * @param {Object} node - The node to search in.
 * @returns {Object|undefined} - The first 'gtRow' node found, or undefined if not found.
 */
function findFirstGtRowInNode(node) {
    if (node && node.type === 'gtRow') {
        return node;
    }
    if (node.children) {
        for (const child of node.children) {
            return findFirstGtRowInNode(child);
        }
    }
}


/**
 * Generate a Docx file from the given mdast.
 * @param {Object} mdast - The mdast representing the document.
 * @returns {Promise} A promise that resolves to the generated Docx file.
 */
async function generateDocxFromMdast(mdast) {
    logger.info('Docx file Docx file generation from mdast started...');
    return await mdast2docx(mdast);   
}

module.exports = updateDocument;
