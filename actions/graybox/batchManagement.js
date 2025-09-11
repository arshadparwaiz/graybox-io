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
import { convertFragmentUrlToSharePointPath } from './pathProcessing.js';
import { fetchPageContent } from './fragmentDiscovery.js';

const logger = getAioLogger();
const BATCH_REQUEST_BULK_COPY = 200;

/**
 * Categorize fragments based on their nested fragment content
 */
export async function categorizeFragments(processedPaths, helixUtils) {
    const fragmentsWithNestedFragments = [];
    const fragmentsWithoutNestedFragments = [];

    for (const page of processedPaths) {
        if (page.fragments && page.fragments.length > 0) {
            for (const fragment of page.fragments) {
                if (fragment.nestedFragments && fragment.nestedFragments.length > 0) {
                    const fragmentSourcePath = convertFragmentUrlToSharePointPath(fragment.fragmentPath);
                    fragmentsWithNestedFragments.push({
                        fragmentPath: fragment.fragmentPath,
                        sourcePath: fragmentSourcePath,
                        nestedFragmentCount: fragment.nestedFragments.length,
                        nestedFragments: fragment.nestedFragments,
                        sourcePage: page.sourcePath,
                        type: 'fragment_with_nested',
                        mdPath: `${fragment.fragmentPath}.md`
                    });
                    
                    // Also analyze each nested fragment to see if it has its own nested fragments
                    for (const nestedFragment of fragment.nestedFragments) {
                        // Check if this nested fragment itself contains fragments
                        const nestedFragmentContent = await fetchPageContent(nestedFragment.fragmentPath, helixUtils);
                        if (nestedFragmentContent) {
                            const nestedFragmentMatches = nestedFragmentContent.match(/<https:\/\/[^>]*aem\.page[^>]*\/fragments\/[^>]*>/g) || [];
                            
                            if (nestedFragmentMatches.length > 0) {
                                // This nested fragment has its own nested fragments
                                const nestedFragmentSourcePath = convertFragmentUrlToSharePointPath(nestedFragment.fragmentPath);
                                fragmentsWithNestedFragments.push({
                                    fragmentPath: nestedFragment.fragmentPath,
                                    sourcePath: nestedFragmentSourcePath,
                                    nestedFragmentCount: nestedFragmentMatches.length,
                                    nestedFragments: nestedFragmentMatches.map(match => ({
                                        fragmentPath: match.slice(1, -1),
                                        status: 200,
                                        availability: 'Available'
                                    })),
                                    sourcePage: page.sourcePath,
                                    type: 'nested_fragment_with_nested',
                                    mdPath: `${nestedFragment.fragmentPath}.md`
                                });
                            } else {
                                // This nested fragment has no nested fragments
                                const nestedFragmentSourcePath = convertFragmentUrlToSharePointPath(nestedFragment.fragmentPath);
                                fragmentsWithoutNestedFragments.push({
                                    fragmentPath: nestedFragment.fragmentPath,
                                    sourcePath: nestedFragmentSourcePath,
                                    nestedFragmentCount: 0,
                                    nestedFragments: [],
                                    sourcePage: page.sourcePath,
                                    type: 'nested_fragment_no_nested',
                                    mdPath: `${nestedFragment.fragmentPath}.md`
                                });
                            }
                        } else {
                            // Could not fetch content, assume no nested fragments
                            const nestedFragmentSourcePath = convertFragmentUrlToSharePointPath(nestedFragment.fragmentPath);
                            fragmentsWithoutNestedFragments.push({
                                fragmentPath: nestedFragment.fragmentPath,
                                sourcePath: nestedFragmentSourcePath,
                                nestedFragmentCount: 0,
                                nestedFragments: [],
                                sourcePage: page.sourcePath,
                                type: 'nested_fragment_no_nested',
                                mdPath: `${nestedFragment.fragmentPath}.md`
                            });
                        }
                    }
                } else {
                    // This fragment has no nested fragments
                    const fragmentSourcePath = convertFragmentUrlToSharePointPath(fragment.fragmentPath);
                    fragmentsWithoutNestedFragments.push({
                        fragmentPath: fragment.fragmentPath,
                        sourcePath: fragmentSourcePath,
                        nestedFragmentCount: 0,
                        nestedFragments: [],
                        sourcePage: page.sourcePath,
                        type: 'fragment_no_nested',
                        mdPath: `${fragment.fragmentPath}.md`
                    });
                }
            }
        }
    }

    return {
        fragmentsWithNestedFragments,
        fragmentsWithoutNestedFragments
    };
}

/**
 * Create consolidated fragment data structure
 */
export function createConsolidatedFragmentData(processedPaths, filesWithFragments, filesWithoutFragments, fragmentsWithNestedFragments, fragmentsWithoutNestedFragments) {
    return {
        summary: {
            totalFiles: processedPaths.length,
            filesWithFragments: filesWithFragments.length,
            filesWithoutFragments: filesWithoutFragments.length,
            totalFragments: fragmentsWithNestedFragments.length + fragmentsWithoutNestedFragments.length,
            fragmentsWithNested: fragmentsWithNestedFragments.length,
            fragmentsWithoutNested: fragmentsWithoutNestedFragments.length,
            batchesCreated: 0, // Will be updated below
            timestamp: new Date().toISOString()
        },
        pages: {
            withFragments: filesWithFragments.map((file) => ({
                ...file,
                category: 'page_with_fragments',
                processingPriority: 'high'
            })),
            withoutFragments: filesWithoutFragments.map((file) => ({
                ...file,
                category: 'page_no_fragments',
                processingPriority: 'low'
            }))
        },
        fragments: {
            withNested: fragmentsWithNestedFragments.map((fragment) => ({
                ...fragment,
                category: 'fragment_with_nested',
                processingPriority: 'high',
                requiresRecursiveProcessing: true
            })),
            withoutNested: fragmentsWithoutNestedFragments.map((fragment) => ({
                ...fragment,
                category: 'fragment_no_nested',
                processingPriority: 'medium',
                requiresRecursiveProcessing: false
            }))
        }
    };
}

/**
 * Create processing and non-processing batches
 */
export async function createBatches(filesNeedingProcessing, filesNotNeedingProcessing, filesWrapper, bulkCopyBatchesFolder) {
    const batchStatusJson = {};
    const bulkCopyBatchesJson = {};

    const processingBatchesArray = [];
    const processingWritePromises = [];

    logger.info(`Creating processing batches for ${filesNeedingProcessing.length} files`);
    for (let i = 0, batchCounter = 1; i < filesNeedingProcessing.length; i += BATCH_REQUEST_BULK_COPY, batchCounter += 1) {
        const arrayChunk = filesNeedingProcessing.slice(i, i + BATCH_REQUEST_BULK_COPY);
        processingBatchesArray.push(arrayChunk);
        const batchName = `processing_batch_${batchCounter}`;
        batchStatusJson[`${batchName}`] = 'initiated';

        processingWritePromises.push(filesWrapper.writeFile(`${bulkCopyBatchesFolder}/${batchName}.json`, arrayChunk));
        bulkCopyBatchesJson[batchName] = arrayChunk;
    }

    const nonProcessingBatchesArray = [];
    const nonProcessingWritePromises = [];

    logger.info(`Creating non-processing batches for ${filesNotNeedingProcessing.length} files`);
    for (let i = 0, batchCounter = 1; i < filesNotNeedingProcessing.length; i += BATCH_REQUEST_BULK_COPY, batchCounter += 1) {
        const arrayChunk = filesNotNeedingProcessing.slice(i, i + BATCH_REQUEST_BULK_COPY);
        nonProcessingBatchesArray.push(arrayChunk);
        const batchName = `non_processing_batch_${batchCounter}`;
        batchStatusJson[`${batchName}`] = 'initiated';

        nonProcessingWritePromises.push(filesWrapper.writeFile(`${bulkCopyBatchesFolder}/${batchName}.json`, arrayChunk));
        bulkCopyBatchesJson[batchName] = arrayChunk;
    }

    const writeBatchJsonPromises = [...processingWritePromises, ...nonProcessingWritePromises];
    const totalBatches = processingBatchesArray.length + nonProcessingBatchesArray.length;

    await Promise.all(writeBatchJsonPromises);

    return {
        batchStatusJson,
        bulkCopyBatchesJson,
        processingBatchesArray,
        nonProcessingBatchesArray,
        totalBatches
    };
}

/**
 * Update consolidated fragment data with batch information
 */
// eslint-disable-next-line max-len
export function updateConsolidatedFragmentDataWithBatches(consolidatedFragmentData, batchStatusJson, bulkCopyBatchesJson, totalBatches, processingBatchesArray, nonProcessingBatchesArray, bulkCopyBatchesFolder) {
    consolidatedFragmentData.summary.batchesCreated = totalBatches;
    consolidatedFragmentData.batches = {
        batchStatus: batchStatusJson,
        batchFiles: bulkCopyBatchesJson,
        batchCount: totalBatches,
        batchFolder: bulkCopyBatchesFolder,
        processingBatches: {
            count: processingBatchesArray.length,
            batchNames: processingBatchesArray.map((_, index) => `processing_batch_${index + 1}.json`),
            description: 'Files/pages/fragments that NEED processing (have fragments or nested fragments)',
            priority: 'high'
        },
        nonProcessingBatches: {
            count: nonProcessingBatchesArray.length,
            batchNames: nonProcessingBatchesArray.map((_, index) => `non_processing_batch_${index + 1}.json`),
            description: 'Files/pages/fragments that DON\'T need processing (no fragments or nested fragments)',
            priority: 'low'
        }
    };

    return consolidatedFragmentData;
}
