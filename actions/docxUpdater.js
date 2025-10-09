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
import parseMarkdown from 'milo-parse-markdown';
import { mdast2docx } from 'milo-md2docx';
import { getAioLogger } from './utils.js';
import DEFAULT_STYLES from './defaultstyles.xml.js';

const gbStyleExpression = 'gb-'; // graybox style expression. need to revisit if there are any more styles to be considered.
const emptyString = '';
const grayboxStylesRegex = /gb-[a-zA-Z0-9,._-]*/g;
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
async function updateDocument(content, expName, hlxAdminApiKey) {
    firstGtRows = [];
    let docx;
    const state = { content: { data: content }, log: '' };
    await parseMarkdown(state);
    const { mdast } = state.content;
    const mdastChildren = mdast.children;

    // Transform Graybox Links
    updateExperienceNameFromLinks(mdastChildren, expName);

    // Remove Graybox Styles
    iterateGtRowsToReplaceStyles();

    // Delete all Graybox Blocks in the document
    iterateGtRowsToDeleteGrayboxBlock(mdastChildren);

    try {
        // generated docx file from updated mdast
        docx = await generateDocxFromMdast(mdast, hlxAdminApiKey);
    } catch (err) {
        // Mostly bad string ignored
        logger.debug(`Error while generating docxfromdast ${err}`);
    }

    return docx;
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
            // Process link URLs
            if (child.type === 'link' && child.url && (child.url.includes(expName) || child.url.includes(gbDomainSuffix))) {
                child.url = child.url.replaceAll(`/${expName}/`, '/').replaceAll(gbDomainSuffix, emptyString);
            }

            // Process link text content that contains graybox URLs
            if (child.type === 'link' && child.children) {
                child.children.forEach((textNode) => {
                    if (textNode.type === 'text' && textNode.value &&
                        (textNode.value.includes(gbDomainSuffix) || textNode.value.includes(expName))) {
                        textNode.value = textNode.value.replaceAll(`/${expName}/`, '/').replaceAll(gbDomainSuffix, emptyString);
                    }
                });
            }

            if (child.children) {
                updateExperienceNameFromLinks(child.children, expName);
            }
        });
    }
};

/**
 * Helper function, iterates through the firstGtRows array and replaces graybox styles for each row.
 */
const iterateGtRowsToReplaceStyles = () => {
    try {
        firstGtRows.forEach((gtRow) => {
            if (gtRow && gtRow.children) {
                replaceGrayboxStyles(gtRow);
            }
        });
    } catch (err) {
        // Mostly bad string ignored
        logger.debug(`Error while iterating GTRows to replaces styles ${err}`);
    }
};

/**
 * Replaces all graybox styles from blocks and text.
 *
 * @param {object} node - The node to process.
 * @returns {void}
 */
const replaceGrayboxStyles = (node) => {
    // replace all graybox styles from blocks and text
    if (node && node.type === 'text' && node.value && node.value.includes(gbStyleExpression)) {
        node.value = node.value.replace(grayboxStylesRegex, emptyString)
            .replace('()', emptyString).replace(', )', ')');
        return;
    }
    if (node.children) {
        node.children.forEach((child) => {
            replaceGrayboxStyles(child);
        });
    }
};

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
        const foundNodes = node.children.map(findFirstGtRowInNode).filter(Boolean);
        return foundNodes.length > 0 ? foundNodes[0] : null;
    }
    return null;
}

/**
 * Check if the content contains any fragment paths
 * @param {string} content - The content to check
 * @returns {boolean} - True if content contains any fragment paths
 */
function hasFragmentPathsInLink(content) {
    // Find fragment links in content - can be in angle bracket format or plain URLs
    // Pattern matches: <https://...aem.page/.../fragments/...> OR https://...aem.page/.../fragments/...> OR hlx.page variants
    if (!content) {
        logger.info('In hasFragmentPathsInLink, content is null/undefined');
        return false;
    }
    // Check for both angle bracket format and plain URL format
    const angleBracketMatches = content.match(/<https:\/\/[^>]*(?:aem|hlx)\.page[^>]*\/fragments\/[^>]*>/g);
    const plainUrlMatches = content.match(/https:\/\/[^>]*(?:aem|hlx)\.page[^>]*\/fragments\/[^>]*/g);
    const matches = angleBracketMatches || plainUrlMatches;
    // eslint-disable-next-line max-len
    logger.info(`In hasFragmentPathsInLink, checking content: ${content}, angle bracket matches: ${angleBracketMatches ? angleBracketMatches.length : 0}, plain URL matches: ${plainUrlMatches ? plainUrlMatches.length : 0}`);
    return matches;
}

/**
 * Transforms a fragment URL by replacing repository and adding experience name to path.
 * @param {string} url - The URL to transform
 * @param {string} expName - The experience name to add to the path
 * @param {string} mainRepo - The main repository name
 * @param {string} grayboxRepo - The graybox repository name
 * @returns {string} The transformed URL
 */
const transformFragmentUrl = (url, expName, mainRepo, grayboxRepo) => {
    try {
        const urlParts = url.includes('.aem.page') ? url.split('.aem.page') : url.split('.hlx.page');
        if (urlParts.length === 2) {
            const domain = urlParts[0];
            const path = urlParts[1];

            // Transform the URL: replace repo and restructure path
            const newDomain = domain.replace(`--${mainRepo}--`, `--${grayboxRepo}--`);

            // Check if the experience name is already in the path to avoid duplication
            const newPath = path.startsWith(`/${expName}/`) ?
                path :
                `/${expName}${path}`;

            return `${newDomain}.aem.page${newPath}`;
        }

        // Fallback to original logic if URL structure is unexpected
        return url
            .replace(`--${mainRepo}--`, `--${grayboxRepo}--`)
            .replace(/\/fragments\//, `/${expName}/fragments/`);
    } catch (error) {
        logger.error(`Error transforming fragment URL: ${error.message}`);
        return url; // Return original URL on error
    }
};

/**
 * Transforms fragment URLs in text content, preserving angle brackets if present.
 * @param {string} text - The text content containing URLs
 * @param {string} expName - The experience name to add to the path
 * @param {string} mainRepo - The main repository name
 * @param {string} grayboxRepo - The graybox repository name
 * @returns {string} The transformed text content
 */
const transformFragmentUrlsInText = (text, expName, mainRepo, grayboxRepo) => {
    const fragmentUrlRegex = /(<)?https:\/\/[^>]*(?:aem|hlx)\.page[^>]*\/fragments\/[^>]*(>)?/g;

    return text.replace(fragmentUrlRegex, (match) => {
        const hasAngleBrackets = match.startsWith('<');
        const url = match.replace(/[<>]/g, '');
        const transformed = transformFragmentUrl(url, expName, mainRepo, grayboxRepo);

        logger.info(`Transformed fragment URL in text: ${match} -> ${hasAngleBrackets ? `<${transformed}>` : transformed}\n Original URL: ${url}`);
        return hasAngleBrackets ? `<${transformed}>` : transformed;
    });
};

/**
 * Processes text nodes that contain fragment URLs.
 * @param {Object} textNode - The text node to process
 * @param {string} expName - The experience name to add to the path
 * @param {string} mainRepo - The main repository name
 * @param {string} grayboxRepo - The graybox repository name
 */
const processTextNode = (textNode, expName, mainRepo, grayboxRepo) => {
    if (textNode.type === 'text' && textNode.value && hasFragmentPathsInLink(textNode.value)) {
        logger.info(`Processing text node with fragment URLs: ${textNode.value}`);
        textNode.value = transformFragmentUrlsInText(textNode.value, expName, mainRepo, grayboxRepo);
    }
};

/**
 * Processes link nodes that contain fragment URLs.
 * @param {Object} linkNode - The link node to process
 * @param {string} expName - The experience name to add to the path
 * @param {string} mainRepo - The main repository name
 * @param {string} grayboxRepo - The graybox repository name
 */
const processLinkNode = (linkNode, expName, mainRepo, grayboxRepo) => {
    if (!linkNode.url || !hasFragmentPathsInLink(linkNode.url)) {
        logger.info(`Link does not contain fragments: ${linkNode.url}`);
        return;
    }

    logger.info(`Processing fragment link: ${linkNode.url}`);
    const originalUrl = linkNode.url;
    linkNode.url = transformFragmentUrl(linkNode.url, expName, mainRepo, grayboxRepo);
    logger.info(`Transformed link URL: ${originalUrl} -> ${linkNode.url}`);
};

/**
 * Processes link text content that contains fragment URLs.
 * @param {Object} linkNode - The link node to process
 * @param {string} expName - The experience name to add to the path
 * @param {string} mainRepo - The main repository name
 * @param {string} grayboxRepo - The graybox repository name
 */
const processLinkTextContent = (linkNode, expName, mainRepo, grayboxRepo) => {
    if (!linkNode.children) return;

    linkNode.children.forEach((textNode) => {
        processTextNode(textNode, expName, mainRepo, grayboxRepo);
    });
};

/**
 * Processes a single child node in the mdast.
 * @param {Object} child - The child node to process
 * @param {string} expName - The experience name to add to the path
 * @param {string} mainRepo - The main repository name
 * @param {string} grayboxRepo - The graybox repository name
 */
const processChildNode = (child, expName, mainRepo, grayboxRepo) => {
    // Handle grid table nodes
    if (child.type === 'gridTable') {
        firstGtRows.push(findFirstGtRowInNode(child));
    }

    // Process text nodes
    if (child.type === 'text') {
        processTextNode(child, expName, mainRepo, grayboxRepo);
    }

    // Process link nodes
    if (child.type === 'link') {
        processLinkNode(child, expName, mainRepo, grayboxRepo);
        processLinkTextContent(child, expName, mainRepo, grayboxRepo);
    }

    // Recursively process child nodes
    if (child.children) {
        addExperienceNameToFragmentLinks(child.children, expName, {
            getRepo: (isGraybox) => (isGraybox ? grayboxRepo : mainRepo)
        });
    }
};

/**
 * Add experience name to fragment links in the given mdast.
 * @param {Array|Object} mdast - The mdast to process (can be array of children or single node)
 * @param {string} expName - The name of the experience
 * @param {Object} helixUtils - The helix utils object containing getRepo method
 */
const addExperienceNameToFragmentLinks = (mdast, expName, helixUtils) => {
    if (!mdast || !expName || !helixUtils) {
        logger.warn('Invalid parameters provided to addExperienceNameToFragmentLinks');
        return;
    }

    try {
        const mainRepo = helixUtils.getRepo(false);
        const grayboxRepo = helixUtils.getRepo(true);

        if (!mainRepo || !grayboxRepo) {
            logger.error('Failed to get repository names from helixUtils');
            return;
        }

        const children = Array.isArray(mdast) ? mdast : [mdast];

        children.forEach((child) => {
            processChildNode(child, expName, mainRepo, grayboxRepo);
        });
    } catch (error) {
        logger.error(`Error in addExperienceNameToFragmentLinks: ${error.message}`);
    }
};

async function updateDocumentForBulkCopy(content, expName, hlxAdminApiKey, helixUtils) {
    firstGtRows = [];
    let docx;
    const state = { content: { data: content }, log: '' };
    await parseMarkdown(state);
    const { mdast } = state.content;
    const mdastChildren = mdast.children;

    logger.info(`In updateDocumentForBulkCopy, mdastChildren: ${JSON.stringify(mdastChildren)}`);
    // Add Experience Name to Graybox Fragment Links
    addExperienceNameToFragmentLinks(mdastChildren, expName, helixUtils);

    try {
        logger.info(`In updateDocumentForBulkCopy, before generating docx: ${JSON.stringify(mdast)}`);
        // generated docx file from updated mdast
        docx = await generateDocxFromMdast(mdast, hlxAdminApiKey);
        logger.info(`Afterwards In generateDocxFromMdast, docx size: ${docx.length || docx.byteLength} bytes`);
    } catch (err) {
        // Mostly bad string ignored
        logger.debug(`Error while generating docxfromdast ${err}`);
    }

    return docx;
}

/**
 * Checks if the given node is a graybox block.
 */
const isGbBlock = (gtRowNode) => {
    if (gtRowNode && gtRowNode.children) {
        // eslint-disable-next-line no-restricted-syntax
        for (const child of gtRowNode.children) {
            if (child.type === 'text' && child.value && child.value.includes('graybox')) {
                return true;
            }
            if (isGbBlock(child)) {
                return true;
            }
        }
    }
    return false;
};

/**
 * Find and delete all graybox blocks from the given mdast.
 */
const iterateGtRowsToDeleteGrayboxBlock = (mdastChildren) => {
    try {
        let blockCtr = -1;
        const gbBlockIndexes = [];
        mdastChildren.forEach((gtRow) => {
            // Increment for each block
            blockCtr += 1;
            const isGrayboxBlock = isGbBlock(gtRow);
            if (isGrayboxBlock) {
                gbBlockIndexes.push(blockCtr);
            }
        });
        let updatedGbIndexCtr = 0;
        gbBlockIndexes.forEach((index) => {
            mdastChildren.splice(index - updatedGbIndexCtr, 1);
            updatedGbIndexCtr += 1;
        });
    } catch (err) {
        logger.error(`Error while iterating GTRows to Delete Graybox Blocks ${err}`);
    }
};

/**
 * Generate a Docx file from the given mdast.
 * @param {Object} mdast - The mdast representing the document.
 * @returns {Promise} A promise that resolves to the generated Docx file.
 */
async function generateDocxFromMdast(mdast, hlxAdminApiKey) {
    const options = {
        stylesXML: DEFAULT_STYLES,
        auth: {
            authorization: `token ${hlxAdminApiKey}`,
        }
    };

    const docx = await mdast2docx(mdast, options);

    return docx;
}

export {
    updateDocument,
    updateDocumentForBulkCopy,
};
