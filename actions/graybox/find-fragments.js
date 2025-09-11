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

import fetch from 'node-fetch';
import { getAioLogger, strToArray } from '../utils.js';
import AppConfig from '../appConfig.js';
import HelixUtils from '../helixUtils.js';

async function main(params) {
    const logger = getAioLogger('find-fragments', params.LOG_LEVEL || 'info');
    const sourcePaths = strToArray(params.sourcePaths);
    if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
        return {
            statusCode: 400,
            body: {
                error: 'sourcePaths must be a non-empty array or comma-separated string'
            }
        };
    }

    const appConfig = new AppConfig(params);
    const helixUtils = new HelixUtils(appConfig);
    const processedPaths = new Set();

    const aemPaths = sourcePaths.filter((path) => path.includes('aem.page'));

    const processPath = async (originalPath, isFragment = false) => {
        let pathToProcess = originalPath;

        if (processedPaths.has(pathToProcess)) {
            return [];
        }
        processedPaths.add(pathToProcess);

        const options = {};
        const grayboxHlxAdminApiKey = helixUtils.getAdminApiKey(false);
        if (grayboxHlxAdminApiKey) {
            options.headers = new fetch.Headers();
            options.headers.append('Authorization', `token ${grayboxHlxAdminApiKey}`);
        }

        if (!pathToProcess.endsWith('.md')) {
            pathToProcess += '.md';
        }

        const response = await fetch(`${pathToProcess}`, options);
        const content = await response.text();
        logger.info(`Content from ${isFragment ? 'fragment' : 'sharepoint'} in find-fragments: ${content.substring(0, 500)}...`);

        // Find fragment links in content using angle bracket format
        // Pattern matches: <https://...aem.page/.../fragments/...>
        const fragmentMatches = content.match(/<https:\/\/[^>]*aem\.page[^>]*\/fragments\/[^>]*>/g) || [];
        const pathFragmentLinks = [];

        const fragmentPromises = fragmentMatches.map(async (match) => {
            const cleanUrl = match.slice(1, -1);
            try {
                const fragmentResponse = await fetch(cleanUrl, options);
                return {
                    fragmentPath: cleanUrl,
                    status: fragmentResponse.status,
                    availability: fragmentResponse.status === 200 ? 'Available' : 'Missing'
                };
            } catch (error) {
                return {
                    fragmentPath: cleanUrl,
                    status: 500,
                    availability: 'Server Error'
                };
            }
        });

        const fragmentResults = await Promise.all(fragmentPromises);
        pathFragmentLinks.push(...fragmentResults);

        logger.info(`Found ${fragmentMatches.length} fragment links in ${originalPath}`);

        const recursiveFragmentPromises = pathFragmentLinks.map(async (fragment) => {
            try {
                if (fragment.status === 200) {
                    return await processPath(fragment.fragmentPath, true);
                }
                return [fragment];
            } catch (error) {
                logger.error(`Error processing fragment ${fragment.fragmentPath}: ${error.message}`);
                return [{
                    fragmentPath: fragment.fragmentPath,
                    status: 500,
                    availability: 'Server Error'
                }];
            }
        });

        const recursiveResults = await Promise.all(recursiveFragmentPromises);
        const flattenedRecursiveResults = recursiveResults.flat();

        return [...pathFragmentLinks, ...flattenedRecursiveResults];
    };

    // Processing all paths in parallel
    const results = await Promise.all(aemPaths.map((path) => processPath(path)));

    // Adding all found fragment links to the set with their status
    const fragmentsWithStatus = [];
    results.forEach((pathLinks) => {
        pathLinks.forEach((fragment) => {
            if (!fragmentsWithStatus.some((f) => f.fragmentPath === fragment.fragmentPath)) {
                fragmentsWithStatus.push(fragment);
            }
        });
    });

    logger.info(`Found fragments with status: ${JSON.stringify(fragmentsWithStatus)}`);

    return {
        statusCode: 200,
        body: {
            fragmentLinks: fragmentsWithStatus.map((fragment) => ({
                fragmentPath: fragment.fragmentPath,
                status: fragment.status,
                availability: fragment.status === 200 ? 'Available' : 'Missing',
                sourcePath: fragment.sourcePath
            }))
        }
    };
}

export { main };
