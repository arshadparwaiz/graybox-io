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
import { getAioLogger } from '../utils.js';

const logger = getAioLogger();

/**
 * Discover fragments and nested fragments for a given AEM page URL
 * Using the same logic as find-fragments.js
 */
export async function discoverFragments(pageUrl, helixUtils) {
    const fragments = [];
    const discoveredFragments = new Set();
    
    try {
        const pageContent = await fetchPageContent(pageUrl, helixUtils);
        if (!pageContent) {
            return fragments;
        }

        // Find fragment links in content using angle bracket format
        // Pattern matches: <https://...aem.page/.../fragments/...> or <https://...hlx.page/.../fragments/...>
        const fragmentMatches = pageContent.match(/<https:\/\/[^>]*(?:aem|hlx)\.page[^>]*\/fragments\/[^>]*>/g) || [];

        logger.info(`Found ${fragmentMatches.length} fragment links in ${pageUrl}`);

        // Process each fragment match
        for (const match of fragmentMatches) {
            const cleanUrl = match.slice(1, -1)?.replace('#_dnt', ''); // Also remove the #_dnt parameter added into the Fragment Path by Loc
            if (discoveredFragments.has(cleanUrl)) {
                continue;
            }
            discoveredFragments.add(cleanUrl);

            try {
                // Check if fragment exists
                const fragmentContent = await fetchPageContent(cleanUrl, helixUtils);
                const fragmentStatus = fragmentContent ? 200 : 404;
                
                // Discover nested fragments if this fragment exists
                let nestedFragments = [];
                if (fragmentStatus === 200) {
                    nestedFragments = await discoverNestedFragments(fragmentContent, discoveredFragments, helixUtils);
                }
                
                fragments.push({
                    fragmentPath: cleanUrl,
                    status: fragmentStatus,
                    availability: fragmentStatus === 200 ? 'Available' : 'Missing',
                    nestedFragments,
                    nestedFragmentCount: nestedFragments.length
                });
            } catch (error) {
                logger.error(`Error processing fragment ${cleanUrl}: ${error.message}`);
                fragments.push({
                    fragmentPath: cleanUrl,
                    status: 500,
                    availability: 'Server Error',
                    nestedFragments: [],
                    nestedFragmentCount: 0,
                    error: error.message
                });
            }
        }
    } catch (error) {
        logger.error(`Error discovering fragments for ${pageUrl}: ${error.message}`);
    }

    return fragments;
}

/**
 * Discover nested fragments within a fragment's content
 */
export async function discoverNestedFragments(content, discoveredFragments, helixUtils) {
    if (!content) {
        return [];
    }

    const nestedFragments = [];
    const fragmentMatches = content.match(/<https:\/\/[^>]*aem\.page[^>]*\/fragments\/[^>]*>/g) || [];
    
    for (const match of fragmentMatches) {
        const cleanUrl = match.slice(1, -1)?.replace('#_dnt', ''); // Also remove the #_dnt parameter added into the Fragment Path by Loc
        
        if (discoveredFragments.has(cleanUrl)) {
            continue;
        }
        discoveredFragments.add(cleanUrl);

        try {
            const fragmentContent = await fetchPageContent(cleanUrl, helixUtils);
            nestedFragments.push({
                fragmentPath: cleanUrl,
                status: fragmentContent ? 200 : 404,
                availability: fragmentContent ? 'Available' : 'Missing'
            });
        } catch (error) {
            logger.error(`Error processing nested fragment ${cleanUrl}: ${error.message}`);
            nestedFragments.push({
                fragmentPath: cleanUrl,
                status: 500,
                availability: 'Server Error',
                error: error.message
            });
        }
    }

    return nestedFragments;
}

/**
 * Fetch content from a URL
 */
export async function fetchPageContent(url, helixUtils) {
    try {
        const options = {};
        const adminApiKey = helixUtils.getAdminApiKey(false);
        if (adminApiKey) {
            options.headers = new fetch.Headers();
            options.headers.append('Authorization', `token ${adminApiKey}`);
        }

        let urlToFetch = url;
        if (!urlToFetch.endsWith('.md')) {
            urlToFetch = `${urlToFetch}.md`;
        }

        const response = await fetch(urlToFetch, options);
        if (response.ok) {
            const content = await response.text();
            return content;
        }
        return null;
    } catch (error) {
        logger.error(`Error fetching content from ${url}: ${error.message}`);
        return null;
    }
}
