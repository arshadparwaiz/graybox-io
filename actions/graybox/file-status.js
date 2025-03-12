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

const initFilesWrapper = require('./filesWrapper');
const {
    getAioLogger
} = require('../utils');

async function main(params) {
    const logger = getAioLogger();
    const filesWrapper = await initFilesWrapper(logger);

    let responsePayload = 'Graybox List AIO File Content API invoked';
    const responseCode = 200;
    logger.info(responsePayload);

    const {
        showContent, showContentDetails, projectFiles, removeItem
    } = params;

    logger.info(`showContent: ${showContent}, showContentDetails: ${showContentDetails}, projectFiles: ${projectFiles}, removeItem: ${removeItem}`);
    if (showContent) {
        const fileContent = await filesWrapper.readFileIntoBuffer(showContent);
        logger.info(`File content: ${fileContent.toString()}`);
        try {
            responsePayload = {
                fileName: showContent,
                fileContent: JSON.parse(fileContent.toString()),
            };
            return {
                code: responseCode,
                payload: responsePayload,
            };
        } catch (err) {
            responsePayload = {
                fileName: showContent,
                fileContent: fileContent.toString('base64'),
            };
            return {
                code: responseCode,
                payload: responsePayload,
            };
        }
    }
    if (showContentDetails) {
        const fileContent = await filesWrapper.readFileIntoBuffer(showContentDetails);
        const fileContentDetails = await filesWrapper.readProperties(showContentDetails);
        try {
            responsePayload = {
                fileName: showContent,
                fileContent: JSON.parse(fileContent.toString()),
                metadata: fileContentDetails,
            };
            return {
                code: responseCode,
                payload: responsePayload,
            };
        } catch (err) {
            responsePayload = {
                fileName: showContent,
                fileContent: fileContent.toString('base64'),
                metadata: fileContentDetails,
            };
            return {
                code: responseCode,
                payload: responsePayload,
            };
        }
    }

    if (removeItem) {
        await filesWrapper.deleteObject(`${removeItem}`);
        responsePayload = {
            status: `Deleted ${removeItem.endsWith('/') ? 'folder' : 'file'} ${removeItem}.`
        };
        return {
            code: responseCode,
            payload: responsePayload,
        };
    }

    if (projectFiles) {
        const allFiles = await filesWrapper.listFiles(`/${projectFiles}/`);
        const result = allFiles.map((fileProperty) => fileProperty.name);
        responsePayload = result;
        return {
            code: responseCode,
            payload: responsePayload,
        };
    }

    responsePayload = 'No action specified';
    return {
        code: responseCode,
        payload: responsePayload,
    };
}

exports.main = main;
