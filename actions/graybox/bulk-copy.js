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

import openwhisk from 'openwhisk';
import { getAioLogger, strToArray } from '../utils.js';
import initFilesWrapper from './filesWrapper.js';

const logger = getAioLogger();

async function main(params) {
    const ow = openwhisk();
    try {
        logger.info('Starting bulk copy operation');
        const requiredParams = ['sourcePaths', 'driveId', 'gbRootFolder', 'rootFolder', 'experienceName', 'projectExcelPath', 'adminPageUri', 'spToken'];
        const missingParams = requiredParams.filter((param) => !params[param]);
        if (missingParams.length > 0) {
            return {
                statusCode: 400,
                body: {
                    error: `Missing required parameters: ${missingParams.join(', ')}`
                }
            };
        }

        const sourcePaths = strToArray(params.sourcePaths);
        if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
            return {
                statusCode: 400,
                body: {
                    error: 'sourcePaths must be a non-empty array or comma-separated string'
                }
            };
        }

        try {
            const processedSourcePaths = sourcePaths.map((path) => {
                if (path.includes('aem.page')) {
                    const regex = /aem\.page(\/.*?)(?:$|\s)|aem\.page\/(.*?)(?:\/[^/]+(?:\.\w+)?)?$/g;
                    const matches = [...path.matchAll(regex)];
                    if (matches.length > 0) {
                        const fullPath = matches[0][1];
                        if (fullPath) {
                            if (!fullPath.includes('.')) {
                                return {
                                    originalUrl: path, // Preserve original AEM page URL for fragment discovery
                                    sourcePath: `${fullPath}.docx`,
                                    destinationPath: `/${params?.experienceName}${fullPath}.docx`
                                };
                            }
                            return {
                                originalUrl: path, // Preserve original AEM page URL for fragment discovery
                                sourcePath: fullPath,
                                destinationPath: `/${params?.experienceName}${fullPath}`
                            };
                        }
                    }
                }
                return {
                    originalUrl: path, // For non-AEM paths, use the path itself
                    sourcePath: path,
                    destinationPath: `/${params?.experienceName}${path}`
                };
            });

            // Create entry in bulk copy project queue
            const filesWrapper = await initFilesWrapper(logger);
            const projectPath = `${params.gbRootFolder}/${params.experienceName}`;
            const bulkCopyProjectQueuePath = 'graybox_promote/bulk_copy_project_queue.json';

            let bulkCopyProjectQueue = [];
            try {
                const queueData = await filesWrapper.readFileIntoObject(bulkCopyProjectQueuePath);
                // Ensure we have an array, even if the file contains something else
                if (Array.isArray(queueData)) {
                    bulkCopyProjectQueue = queueData;
                } else {
                    logger.warn('Queue file exists but does not contain an array, starting with empty queue');
                    bulkCopyProjectQueue = [];
                }
            } catch (err) {
                // File doesn't exist yet, start with empty array
                logger.info('Creating new bulk copy project queue');
            }

            // Ensure bulkCopyProjectQueue is an array before proceeding
            if (!Array.isArray(bulkCopyProjectQueue)) {
                logger.error(`bulkCopyProjectQueue is not an array: ${typeof bulkCopyProjectQueue}, value: ${JSON.stringify(bulkCopyProjectQueue)}`);
                bulkCopyProjectQueue = [];
            }

            logger.info(`Queue contains ${bulkCopyProjectQueue.length} projects`);

            // Check if project already exists in queue
            const existingProjectIndex = bulkCopyProjectQueue.findIndex((p) => p.projectPath === projectPath);
            const queueEntry = {
                projectPath,
                status: 'initiated',
                createdTime: Date.now(),
                updatedTime: Date.now(),
                experienceName: params.experienceName,
                gbRootFolder: params.gbRootFolder,
                sourcePaths: processedSourcePaths,
                totalSourcePaths: processedSourcePaths.length
            };

            if (existingProjectIndex !== -1) {
                // Update existing project entry
                bulkCopyProjectQueue[existingProjectIndex] = queueEntry;
                logger.info(`Updated existing project in bulk copy queue: ${projectPath}`);
            } else {
                // Add new project entry
                bulkCopyProjectQueue.push(queueEntry);
                logger.info(`Added new project to bulk copy queue: ${projectPath}`);
            }

            await filesWrapper.writeFile(bulkCopyProjectQueuePath, bulkCopyProjectQueue);

            const workerParams = {
                ...params,
                sourcePaths: processedSourcePaths,
                driveId: params.driveId,
                gbRootFolder: params.gbRootFolder,
                rootFolder: params.rootFolder,
                experienceName: params.experienceName,
                projectExcelPath: params.projectExcelPath,
                adminPageUri: params.adminPageUri,
                spToken: params.spToken
            };

            await ow.actions.invoke({
                name: 'graybox/bulk-copy-worker',
                blocking: false,
                result: false,
                params: workerParams
            });

            return {
                statusCode: 200,
                body: {
                    pathDetails: processedSourcePaths,
                    message: 'Bulk copy operation started'
                }
            };
        } catch (err) {
            const errorMessage = 'Failed to invoke graybox bulk-copy-worker action';
            logger.error(`${errorMessage}: ${err}`);
            return {
                statusCode: 500,
                body: {
                    error: errorMessage,
                    message: err.message
                }
            };
        }
    } catch (error) {
        logger.error(error);
        return {
            statusCode: 500,
            body: {
                error: 'Internal server error',
                message: error.message
            }
        };
    }
}

export { main };
