/* ***********************************************************************
 * ADOBE CONFIDENTIAL
 * ___________________
 *
 * Copyright 2025 Adobe
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

import { getAioLogger } from '../utils.js';
import { discoverFragments } from './fragmentDiscovery.js';

const logger = getAioLogger();

/**
 * Convert AEM fragment URL to SharePoint path
 * Similar to the logic in bulk-copy.js
 */
export function convertFragmentUrlToSharePointPath(fragmentUrl) {
    if (!fragmentUrl || (!fragmentUrl.includes('aem.page') && !fragmentUrl.includes('hlx.page'))) {
        return null;
    }

    const regex = /(?:aem|hlx)\.page(\/.*?)(?:$|\s)|(?:aem|hlx)\.page\/(.*?)(?:\/[^/]+(?:\.\w+)?)?$/g;
    const matches = [...fragmentUrl.matchAll(regex)];
    if (matches.length > 0) {
        const fullPath = matches[0][1] || matches[0][2];
        if (fullPath) {
            if (!fullPath.includes('.')) {
                return `${fullPath}.docx`;
            }
            return fullPath;
        }
    }

    return null;
}

/**
 * Process source paths to discover fragments and nested fragments
 */
export async function processSourcePaths(sourcePaths, helixUtils, experienceName, appConfig, getPageMdPath) {
    const processedPaths = [];
    const processedUrls = new Set();

    for (const pathInfo of sourcePaths) {
        const sourcePath = typeof pathInfo === 'string' ? pathInfo : pathInfo.sourcePath;
        const originalUrl = pathInfo.originalUrl || sourcePath;
        
        if (processedUrls.has(sourcePath)) {
            continue;
        }
        processedUrls.add(sourcePath);

        try {
            if (originalUrl.includes('aem.page')) {
                const fragments = await discoverFragments(originalUrl, helixUtils);
                
                processedPaths.push({
                    sourcePath,
                    destinationPath: pathInfo.destinationPath || `/${experienceName}${sourcePath}`,
                    hasFragments: fragments.length > 0,
                    fragments,
                    fragmentCount: fragments.length,
                    type: 'page',
                    mdPath: getPageMdPath(pathInfo)
                });
            } else {
                processedPaths.push({
                    sourcePath,
                    destinationPath: pathInfo.destinationPath || `/${experienceName}${sourcePath}`,
                    hasFragments: false,
                    fragments: [],
                    fragmentCount: 0,
                    type: 'file',
                    mdPath: getPageMdPath(pathInfo)
                });
            }
        } catch (error) {
            logger.error(`Error processing path ${sourcePath}: ${error.message}`);
            processedPaths.push({
                sourcePath,
                destinationPath: pathInfo.destinationPath || `/${experienceName}${sourcePath}`,
                hasFragments: false,
                fragments: [],
                fragmentCount: 0,
                type: 'error',
                error: error.message,
                mdPath: getPageMdPath(pathInfo)
            });
        }
    }

    return processedPaths;
}
