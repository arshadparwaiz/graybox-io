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

import { getAioLogger, toUTCStr } from '../utils.js';
import { initializeBulkCopyStatus, updateBulkCopyStepStatus } from './bulkCopyStatusUtils.js';

const logger = getAioLogger();

/**
 * Initialize project status files
 */
export async function initializeProjectStatus(filesWrapper, project, inputParams) {
    const bulkCopyStatus = initializeBulkCopyStatus(project, inputParams.experienceName, inputParams.sourcePathsCount);
    await filesWrapper.writeFile(`graybox_promote${project}/bulk-copy-status.json`, bulkCopyStatus);
    logger.info(`Initialized bulk copy status tracking for project: ${project}`);

    const projectStatusJson = {
        status: 'initiated',
        params: inputParams,
        statuses: [
            {
                stepName: 'initiated',
                step: 'Bulk copy fragment discovery initiated',
                timestamp: toUTCStr(new Date()),
                files: []
            }
        ]
    };

    await filesWrapper.writeFile(`graybox_promote${project}/status.json`, projectStatusJson);
    await filesWrapper.writeFile(`graybox_promote${project}/copy_errors.json`, []);
    await filesWrapper.writeFile(`graybox_promote${project}/copied_paths.json`, {});
}

/**
 * Update bulk copy status with fragment discovery completion
 */
export async function updateBulkCopyStatusCompletion(filesWrapper, project, processedPaths, filesWithFragments, filesWithoutFragments, totalBatches, processingBatchesArray, nonProcessingBatchesArray) {
    const finalStatus = await filesWrapper.readFileIntoObject(`graybox_promote${project}/bulk-copy-status.json`);
    finalStatus.status = 'fragment_discovery_completed';
    if (!finalStatus.statuses) {
        finalStatus.statuses = [];
    }
    finalStatus.statuses.push({
        status: 'fragment_discovery_completed',
        timestamp: toUTCStr(new Date()),
        totalFiles: processedPaths.length,
        filesWithFragments: filesWithFragments.length,
        filesWithoutFragments: filesWithoutFragments.length,
        batchesCreated: totalBatches,
        processingBatches: processingBatchesArray.length,
        nonProcessingBatches: nonProcessingBatchesArray.length
    });
    
    await filesWrapper.writeFile(`graybox_promote${project}/bulk-copy-status.json`, finalStatus);
}

/**
 * Update main project status with fragment discovery completion
 */
export async function updateMainProjectStatusCompletion(filesWrapper, project, processedPaths, filesWithFragments, filesWithoutFragments, totalBatches) {
    const mainProjectStatus = await filesWrapper.readFileIntoObject(`graybox_promote${project}/status.json`);
    mainProjectStatus.status = 'fragment_discovery_completed';
    if (!mainProjectStatus.statuses) {
        mainProjectStatus.statuses = [];
    }
    mainProjectStatus.statuses.push({
        stepName: 'fragment_discovery_completed',
        step: 'Fragment discovery completed successfully',
        timestamp: toUTCStr(new Date()),
        files: processedPaths.map((p) => p.sourcePath),
        totalFiles: processedPaths.length,
        filesWithFragments: filesWithFragments.length,
        filesWithoutFragments: filesWithoutFragments.length,
        batchesCreated: totalBatches
    });

    await filesWrapper.writeFile(`graybox_promote${project}/status.json`, mainProjectStatus);
}

/**
 * Update bulk copy project queue
 */
export async function updateBulkCopyProjectQueue(filesWrapper, project) {
    const bulkCopyProjectQueuePath2 = 'graybox_promote/bulk_copy_project_queue.json';
    const bulkCopyProjectQueue2 = await filesWrapper.readFileIntoObject(bulkCopyProjectQueuePath2);
    const projectIndex = bulkCopyProjectQueue2.findIndex((p) => p.projectPath === project);
    if (projectIndex !== -1) {
        bulkCopyProjectQueue2[projectIndex].status = 'fragment_discovery_completed';
        await filesWrapper.writeFile(bulkCopyProjectQueuePath2, bulkCopyProjectQueue2);
    }
}

/**
 * Write batch files
 */
export async function writeBatchFiles(filesWrapper, bulkCopyBatchesFolder, bulkCopyBatchesJson, batchStatusJson) {
    await filesWrapper.writeFile(`${bulkCopyBatchesFolder}/bulk_copy_batches.json`, bulkCopyBatchesJson);
    await filesWrapper.writeFile(`${bulkCopyBatchesFolder}/batch_status.json`, batchStatusJson);
}

/**
 * Update Excel with fragment discovery results
 */
// eslint-disable-next-line max-len
export async function updateExcelWithFragmentDiscoveryResults(sharepoint, projectExcelPath, processedPaths, filesWithFragments, filesWithoutFragments, fragmentsWithNestedFragments, fragmentsWithoutNestedFragments, totalBatches, processingBatchesArray, nonProcessingBatchesArray) {
    const excelUpdates = [
        ['Bulk Copy Fragment Discovery Completed', toUTCStr(new Date()), '', ''],
        [`Total files processed: ${processedPaths.length}`, toUTCStr(new Date()), '', ''],
        [`Files with fragments: ${filesWithFragments.length}`, toUTCStr(new Date()), '', ''],
        [`Files without fragments: ${filesWithoutFragments.length}`, toUTCStr(new Date()), '', ''],
        [`Total fragments discovered: ${fragmentsWithNestedFragments.length + fragmentsWithoutNestedFragments.length}`, toUTCStr(new Date()), '', ''],
        [`Fragments with nested fragments: ${fragmentsWithNestedFragments.length}`, toUTCStr(new Date()), '', ''],
        [`Fragments without nested fragments: ${fragmentsWithoutNestedFragments.length}`, toUTCStr(new Date()), '', ''],
        [`Total batches created: ${totalBatches}`, toUTCStr(new Date()), '', ''],
        [`Processing batches (high priority): ${processingBatchesArray.length}`, toUTCStr(new Date()), '', ''],
        [`Non-processing batches (low priority): ${nonProcessingBatchesArray.length}`, toUTCStr(new Date()), '', '']
    ];

    await sharepoint.updateExcelTable(projectExcelPath, 'PROMOTE_STATUS', excelUpdates);
}

/**
 * Update bulk copy step status
 */
// eslint-disable-next-line max-len
export async function updateBulkCopyStepStatusCompletion(filesWrapper, project, processedPaths, totalBatches, processingBatchesArray, nonProcessingBatchesArray, filesWithFragments, fragmentsWithNestedFragments) {
    await updateBulkCopyStepStatus(filesWrapper, project, 'step1_discovery', {
        status: 'completed',
        endTime: toUTCStr(new Date()),
        progress: {
            total: processedPaths.length,
            completed: processedPaths.length,
            failed: 0
        },
        details: {
            totalBatches,
            processingBatches: processingBatchesArray.length,
            nonProcessingBatches: nonProcessingBatchesArray.length,
            totalFragments: filesWithFragments.length,
            totalNestedFragments: fragmentsWithNestedFragments.length
        }
    });
}

/**
 * Handle error status updates
 */
export async function handleErrorStatus(filesWrapper, project, projectExcelPath, sharepoint, error) {
    try {
        const errorStatus = await filesWrapper.readFileIntoObject(`graybox_promote${project}/bulk-copy-status.json`);
        errorStatus.status = 'error';
        if (!errorStatus.statuses) {
            errorStatus.statuses = [];
        }
        errorStatus.statuses.push({
            timestamp: toUTCStr(new Date()),
            status: 'error',
            error: error.message
        });
        await filesWrapper.writeFile(`graybox_promote${project}/bulk-copy-status.json`, errorStatus);

        const excelUpdates = [['Bulk Copy Fragment Discovery Failed', toUTCStr(new Date()), error.message, '']];
        await sharepoint.updateExcelTable(projectExcelPath, 'PROMOTE_STATUS', excelUpdates);
    } catch (statusError) {
        logger.error(`Failed to update status file: ${statusError.message}`);
    }
}
