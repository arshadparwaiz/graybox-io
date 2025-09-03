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

const logger = getAioLogger();

async function main(params) {
    const ow = openwhisk();
    try {
        logger.info('Starting bulk copy operation');
        const requiredParams = ['sourcePaths', 'driveId', 'gbRootFolder', 'rootFolder', 'experienceName', 'projectExcelPath', 'adminPageUri', 'spToken'];
        const missingParams = requiredParams.filter(param => !params[param]);
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
        logger.info(`In Bulk Copy, sourcePaths: ${JSON.stringify(sourcePaths)}`);

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
                                    sourcePath: `${fullPath}.docx`,
                                    destinationPath: `/${params?.experienceName}${fullPath}.docx`,
                                    mdPath: `${path}.md`
                                };
                            }
                            return {
                                sourcePath: fullPath,
                                destinationPath: `/${params?.experienceName}${fullPath}`,
                                mdPath: `${path}.md`
                            };
                        }
                    }
                }
                return {
                    sourcePath: path,
                    destinationPath: `/${params?.experienceName}${path}`
                };
            });

            const workerResponse = await ow.actions.invoke({
                // name: 'graybox/bulk-copy-worker',
                name: 'graybox/initiate-bulk-copy-worker',
                blocking: false,
                result: false,
                params: {
                    ...params,
                    sourcePaths: processedSourcePaths
                }
            });

            return {
                statusCode: 200,
                body: {
                    pathDetails: processedSourcePaths,
                    message: 'Bulk copy operation started',
                    activationId: workerResponse.activationId,
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
