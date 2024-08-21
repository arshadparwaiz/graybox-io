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

// eslint-disable-next-line import/no-extraneous-dependencies
const openwhisk = require('openwhisk');
const { getAioLogger } = require('../utils');
const initFilesWrapper = require('./filesWrapper');

async function main(params) {
    const logger = getAioLogger();
    const ow = openwhisk();
    let responsePayload = 'Graybox Promote Scheduler invoked';
    logger.info(responsePayload);

    const filesWrapper = await initFilesWrapper(logger);

    try {
        let projectQueue = await filesWrapper.readFileIntoObject('graybox_promote/project_queue.json');
        logger.info(`From Promote-sched Project Queue Json: ${JSON.stringify(projectQueue)}`);

        // Sorting the Promote Projects based on the 'createdTime' property, pick the oldest project
        projectQueue = projectQueue.sort((a, b) => a.createdTime - b.createdTime);

        // Find the First Project where status is 'processed'
        const projectEntry = projectQueue.find((project) => project.status === 'processed');

        if (projectEntry && projectEntry.projectPath) {
            const project = projectEntry.projectPath;
            const projectStatusJson = await filesWrapper.readFileIntoObject(`graybox_promote${project}/status.json`);

            // Read the Batch Status in the current project's "batch_status.json" file
            const batchStatusJson = await filesWrapper.readFileIntoObject(`graybox_promote${project}/batch_status.json`);

            const promoteBatchesJson = await filesWrapper.readFileIntoObject(`graybox_promote${project}/promote_batches.json`);

            // copy all params from json into the params object
            const inputParams = projectStatusJson?.params;
            Object.keys(inputParams).forEach((key) => {
                params[key] = inputParams[key];
            });

            // Find the first batch where status is 'processed'
            const batchEntry = Object.entries(promoteBatchesJson)
                .find(([batchName, promoteBatchJson]) => promoteBatchJson.status === 'processed');
            const promoteBatchName = batchEntry[0]; // Getting the key i.e. project path from the JSON entry, batchEntry[1] is the value

            if (batchStatusJson[promoteBatchName] === 'processed') {
                // Set the Project & Batch Name in params for the Promote Content Worker Action to read and process
                params.project = project;
                params.batchName = promoteBatchName;

                try {
                    return ow.actions.invoke({
                        name: 'graybox/promote-worker',
                        blocking: false,
                        result: false,
                        params
                    }).then(async (result) => {
                        logger.info(result);
                        return {
                            code: 200,
                            payload: responsePayload
                        };
                    }).catch(async (err) => {
                        responsePayload = 'Failed to invoke graybox promote action';
                        logger.error(`${responsePayload}: ${err}`);
                        return {
                            code: 500,
                            payload: responsePayload
                        };
                    });
                } catch (err) {
                    responsePayload = 'Unknown error occurred while invoking Promote Content Worker Action';
                    logger.error(`${responsePayload}: ${err}`);
                    responsePayload = err;
                }
            }
            responsePayload = 'Triggered Promote Content Worker Action';
            return {
                code: 200,
                payload: responsePayload,
            };
        }
    } catch (err) {
        responsePayload = 'Unknown error occurred while processing the projects for Promote';
        logger.error(`${responsePayload}: ${err}`);
        responsePayload = err;
    }

    // No errors while initiating all the Promote Content Worker Action for all the projects
    return {
        code: 200,
        payload: responsePayload
    };
}

exports.main = main;
