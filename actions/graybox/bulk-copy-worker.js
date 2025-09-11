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

import AppConfig from '../appConfig.js';
import Sharepoint from '../sharepoint.js';
import { getAioLogger } from '../utils.js';
import initFilesWrapper from './filesWrapper.js';
import HelixUtils from '../helixUtils.js';
import { processSourcePaths } from './pathProcessing.js';
import {
    categorizeFragments,
    createConsolidatedFragmentData,
    createBatches,
    updateConsolidatedFragmentDataWithBatches
} from './batchManagement.js';
import {
    initializeProjectStatus,
    updateBulkCopyStatusCompletion,
    updateMainProjectStatusCompletion,
    updateBulkCopyProjectQueue,
    writeBatchFiles,
    updateExcelWithFragmentDiscoveryResults,
    updateBulkCopyStepStatusCompletion,
    handleErrorStatus
} from './statusManagement.js';

const logger = getAioLogger();

async function main(params) {
    logger.info('Graybox Bulk Copy Worker triggered');

    const appConfig = new AppConfig(params);
    const {
        driveId, adminPageUri, rootFolder, gbRootFolder, promoteIgnorePaths, experienceName, projectExcelPath
    } = appConfig.getPayload();

    const sharepoint = new Sharepoint(appConfig);
    const helixUtils = new HelixUtils(appConfig);
    const filesWrapper = await initFilesWrapper(logger);
    const { sourcePaths } = params;

    if (!sourcePaths) {
        throw new Error('sourcePaths parameter is missing');
    }

    if (!Array.isArray(sourcePaths) && typeof sourcePaths !== 'string') {
        throw new Error(`sourcePaths must be an array or string, got: ${typeof sourcePaths}`);
    }

    const sourcePathsArray = Array.isArray(sourcePaths) ? sourcePaths : [sourcePaths];

    logger.info(`Received sourcePaths: ${JSON.stringify(sourcePathsArray)}`);
    logger.info(`First item type: ${typeof sourcePathsArray[0]}`);
    logger.info(`First item: ${JSON.stringify(sourcePathsArray[0])}`);

    const project = `${gbRootFolder}/${experienceName}`;

    try {
        logger.info('Starting bulk copy worker with fragment discovery');

        // Prepare input parameters
        const inputParams = {
            driveId,
            rootFolder,
            gbRootFolder,
            projectExcelPath,
            experienceName,
            adminPageUri,
            promoteIgnorePaths,
            spToken: params.spToken,
            draftsOnly: params.draftsOnly,
            ignoreUserCheck: `${appConfig.ignoreUserCheck()}`,
            sourcePathsCount: sourcePathsArray.length
        };

        // Initialize project status
        await initializeProjectStatus(filesWrapper, project, inputParams);
        logger.info('Project queue entry should already exist from bulk-copy.js invocation');

        // Process source paths to discover fragments
        const getPageMdPath = (pathInfo) => {
            if (pathInfo && pathInfo.originalUrl) {
                return `${pathInfo.originalUrl}.md`;
            }
            return null;
        };

        const processedPaths = await processSourcePaths(sourcePathsArray, helixUtils, experienceName, appConfig, getPageMdPath);

        const filesWithFragments = processedPaths.filter((path) => path.hasFragments);
        const filesWithoutFragments = processedPaths.filter((path) => !path.hasFragments);

        logger.info(`File categorization: ${filesWithFragments.length} files with fragments, ${filesWithoutFragments.length} files without fragments`);

        // Categorize fragments based on nested content
        const { fragmentsWithNestedFragments, fragmentsWithoutNestedFragments } = await categorizeFragments(processedPaths, helixUtils);

        // Create consolidated fragment data
        const consolidatedFragmentData = createConsolidatedFragmentData(
            processedPaths,
            filesWithFragments,
            filesWithoutFragments,
            fragmentsWithNestedFragments,
            fragmentsWithoutNestedFragments
        );

        // Create the consolidated file
        await filesWrapper.writeFile(`graybox_promote${project}/consolidated-fragment-data.json`, consolidatedFragmentData);

        // Create batches
        const bulkCopyBatchesFolder = `graybox_promote${project}/bulk-copy-batches`;
        const filesNeedingProcessing = [...filesWithFragments, ...fragmentsWithNestedFragments];
        const filesNotNeedingProcessing = [...filesWithoutFragments, ...fragmentsWithoutNestedFragments];

        const {
            batchStatusJson,
            bulkCopyBatchesJson,
            processingBatchesArray,
            nonProcessingBatchesArray,
            totalBatches
        } = await createBatches(filesNeedingProcessing, filesNotNeedingProcessing, filesWrapper, bulkCopyBatchesFolder);

        // Update consolidated fragment data with batch information
        const finalConsolidatedFragmentData = updateConsolidatedFragmentDataWithBatches(
            consolidatedFragmentData,
            batchStatusJson,
            bulkCopyBatchesJson,
            totalBatches,
            processingBatchesArray,
            nonProcessingBatchesArray,
            bulkCopyBatchesFolder
        );

        // Update all status files
        await updateBulkCopyStatusCompletion(filesWrapper, project, processedPaths, filesWithFragments, filesWithoutFragments, totalBatches, processingBatchesArray, nonProcessingBatchesArray);
        await updateMainProjectStatusCompletion(filesWrapper, project, processedPaths, filesWithFragments, filesWithoutFragments, totalBatches);
        await updateBulkCopyProjectQueue(filesWrapper, project);
        await writeBatchFiles(filesWrapper, bulkCopyBatchesFolder, bulkCopyBatchesJson, batchStatusJson);
        await filesWrapper.writeFile(`graybox_promote${project}/consolidated-fragment-data.json`, finalConsolidatedFragmentData);

        // Update Excel and step status
        await updateExcelWithFragmentDiscoveryResults(
            sharepoint,
            projectExcelPath,
            processedPaths,
            filesWithFragments,
            filesWithoutFragments,
            fragmentsWithNestedFragments,
            fragmentsWithoutNestedFragments,
            totalBatches,
            processingBatchesArray,
            nonProcessingBatchesArray
        );

        await updateBulkCopyStepStatusCompletion(
            filesWrapper,
            project,
            processedPaths,
            totalBatches,
            processingBatchesArray,
            nonProcessingBatchesArray,
            filesWithFragments,
            fragmentsWithNestedFragments
        );

        return {
            code: 200,
            body: {
                message: 'Bulk copy fragment discovery completed',
                totalFiles: processedPaths.length,
                filesWithFragments: filesWithFragments.length,
                filesWithoutFragments: filesWithoutFragments.length,
                totalBatches,
                processingBatches: processingBatchesArray.length,
                nonProcessingBatches: nonProcessingBatchesArray.length
            }
        };
    } catch (error) {
        logger.error(`Error in bulk copy worker: ${error.message}`);

        await handleErrorStatus(filesWrapper, project, projectExcelPath, sharepoint, error);

        return {
            code: 500,
            body: {
                error: 'Fragment discovery failed',
                message: error.message
            }
        };
    }
}

export { main };
