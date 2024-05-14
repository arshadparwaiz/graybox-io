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

const fetch = require('node-fetch');
const {
    getAioLogger, handleExtension, isFilePatternMatched, toUTCStr
} = require('../utils');
const appConfig = require('../appConfig');
const { getConfig } = require('../config');
const { getAuthorizedRequestOption, fetchWithRetry, updateExcelTable } = require('../sharepoint');
const helixUtils = require('../helixUtils');
const updateDocument = require('../docxUpdater');
const { saveFile, copyFile, promoteCopy } = require('../sharepoint');

const logger = getAioLogger();
const MAX_CHILDREN = 1000;
const IS_GRAYBOX = true;
const BATCH_REQUEST_PREVIEW = 200;

const gbStyleExpression = 'gb-'; // graybox style expression. need to revisit if there are any more styles to be considered.
const gbDomainSuffix = '-graybox';

async function main(params) {
    logger.info('Graybox Promote Worker invoked');

    appConfig.setAppConfig(params);
    const { gbRootFolder, experienceName } = appConfig.getPayload();

    logger.info(`GB ROOT FOLDER ::: ${gbRootFolder}`);
    logger.info(`GB EXP NAME ::: ${experienceName}`);

    // TODO - Bulk Preview docx files
    // TODO - GET markdown files using preview-url.md
    // TODO - Process markdown - process MDAST by cleaning it up
    // TODO - Generate updated Docx file using md2docx lib
    // TODO - copy updated docx file to the default content tree
    // TODO - run the bulk preview action on the list of files that were copied to default content tree
    // TODO - update the project excel file as and when necessary to update the status of the promote action

    // Get all files in the graybox folder for the specific experience name
    // NOTE: This does not capture content inside the locale/expName folders yet
    const gbFiles = await findAllFiles(experienceName, appConfig);
    logger.info(`Files in graybox folder in ${experienceName}`);
    logger.info(JSON.stringify(gbFiles));

    // create batches to process the data
    const batchArray = [];
    for (let i = 0; i < gbFiles.length; i += BATCH_REQUEST_PREVIEW) {
        const arrayChunk = gbFiles.slice(i, i + BATCH_REQUEST_PREVIEW);
        batchArray.push(arrayChunk);
    }

    // process data in batches
    const previewStatuses = [];
    let failedPreviews = [];
    const promoteStatuses = [];
    const failedPromoteStatuses = [];
    if (helixUtils.canBulkPreview()) {
        const paths = [];
        batchArray.forEach((batch) => {
            batch.forEach((gbFile) => paths.push(handleExtension(gbFile.filePath)));
        });
        previewStatuses.push(await helixUtils.bulkPreview(paths, helixUtils.getOperations().PREVIEW, experienceName));
        failedPreviews = previewStatuses.filter((status) => !status.success).map((status) => status.path);

        const helixAdminApiKey = helixUtils.getAdminApiKey();

        const options = {};
        if (helixUtils.getAdminApiKey()) {
            options.headers = new fetch.Headers();
            options.headers.append('Authorization', `token ${helixUtils.getAdminApiKey()}`);
        }

        // iterate through preview statuses and log success
        previewStatuses.forEach((status) => {
            // check if status is an array and iterate through the array
            if (Array.isArray(status)) {
                status.forEach(async (stat) => {
                    if (stat.success && stat.mdPath) {
                        const response = await fetchWithRetry(`${stat.mdPath}`, options);
                        const content = await response.text();
                        let docx;
                        const { sp } = await getConfig();

                        if (content.includes(experienceName) || content.includes(gbStyleExpression) || content.includes(gbDomainSuffix)) {
                            docx = await updateDocument(content, experienceName, helixAdminApiKey);
                            if (docx) {
                                // Save file Destination full path with file name and extension
                                const destinationFilePath = `${stat.path.substring(0, stat.path.lastIndexOf('/') + 1).replace('/'.concat(experienceName), '')}${stat.fileName}`;

                                const saveStatus = await saveFile(docx, destinationFilePath, sp);
                                if (saveStatus && saveStatus.success === true) {
                                    promoteStatuses.push(destinationFilePath);
                                } else {
                                    failedPromoteStatuses.push(destinationFilePath);
                                }
                            } else {
                                logger.error(`Error generating docx file for ${stat.path}`);
                            }
                        } else {
                            const copySourceFilePath = `${stat.path.substring(0, stat.path.lastIndexOf('/') + 1)}${stat.fileName}`; // Copy Source full path with file name and extension
                            const copyDestinationFolder = `${stat.path.substring(0, stat.path.lastIndexOf('/')).replace('/'.concat(experienceName), '')}`; // Copy Destination folder path, no file name
                            const promoteCopyFileStatus = await promoteCopy(copySourceFilePath, copyDestinationFolder, stat.fileName, sp);

                            if (promoteCopyFileStatus) {
                                promoteStatuses.push(`${copyDestinationFolder}/${stat.fileName}`);
                            } else {
                                failedPromoteStatuses.push(`${copyDestinationFolder}/${stat.fileName}`);
                            }
                        }
                    }
                });
            }
        });
    }

    // Update project excel file with status (sample)
    logger.info('Updating project excel file with status');
    const curreDateTime = new Date();
    const { projectExcelPath } = appConfig.getPayload();
    const sFailedPreviews = failedPreviews.length > 0 ? `Failed Previews: \n${failedPreviews.join('\n')}` : '';
    const excelValues = [['Preview', toUTCStr(curreDateTime), sFailedPreviews]];
    // Update Preview Status
    await updateExcelTable(projectExcelPath, 'PROMOTE_STATUS', excelValues, IS_GRAYBOX);

    // Update Promote Status
    const sPromoteStatuses = promoteStatuses.length > 0 ? `Promotes: \n${promoteStatuses.join('\n')}` : '';
    const sFailedPromoteStatuses = failedPromoteStatuses.length > 0 ? `Failed Promotes: \n${failedPromoteStatuses.join('\n')}` : '';
    const promoteExcelValues = [['Promote', toUTCStr(curreDateTime), sPromoteStatuses]];
    const failedPromoteExcelValues = [['Promote', toUTCStr(curreDateTime), sFailedPromoteStatuses]];

    await updateExcelTable(projectExcelPath, 'PROMOTE_STATUS', promoteExcelValues, IS_GRAYBOX);
    await updateExcelTable(projectExcelPath, 'PROMOTE_STATUS', failedPromoteExcelValues, IS_GRAYBOX);

    const responsePayload = 'Graybox Promote Worker action completed.';
    return exitAction({
        body: responsePayload,
    });
}

/**
 * Find all files in the Graybox tree to promote.
 */
async function findAllFiles(experienceName, appConf) {
    const { sp } = await getConfig();
    const options = await getAuthorizedRequestOption({ method: 'GET' });
    const promoteIgnoreList = appConf.getPromoteIgnorePaths();
    logger.info(`Promote ignore list: ${promoteIgnoreList}`);

    return findAllGrayboxFiles({
        baseURI: sp.api.file.get.gbBaseURI,
        options,
        gbFolders: appConf.isDraftOnly() ? [`/${experienceName}/drafts`] : [''],
        promoteIgnoreList,
        downloadBaseURI: sp.api.file.download.baseURI,
        experienceName
    });
}

/**
 * Iteratively finds all files under a specified root folder.
 */
async function findAllGrayboxFiles({
    baseURI, options, gbFolders, promoteIgnoreList, downloadBaseURI, experienceName
}) {
    const gbRoot = baseURI.split(':').pop();
    // Regular expression to select the gbRoot and anything before it
    // Eg: the regex selects "https://<sharepoint-site>:/<app>-graybox"
    const pPathRegExp = new RegExp(`.*:${gbRoot}`);
    // Regular expression to select paths that has the experienceName at first or second level
    const pathsToSelectRegExp = new RegExp(`^/([^/]+/)?${experienceName}(/.*)?$`);
    const gbFiles = [];
    while (gbFolders.length !== 0) {
        const uri = `${baseURI}${gbFolders.shift()}:/children?$top=${MAX_CHILDREN}`;
        // eslint-disable-next-line no-await-in-loop
        const res = await fetchWithRetry(uri, options);
        if (res.ok) {
            // eslint-disable-next-line no-await-in-loop
            const json = await res.json();
            // eslint-disable-next-line no-await-in-loop
            const driveItems = json.value;
            for (let di = 0; di < driveItems?.length; di += 1) {
                const item = driveItems[di];
                const itemPath = `${item.parentReference.path.replace(pPathRegExp, '')}/${item.name}`;
                logger.info(`${itemPath} ::: ${pathsToSelectRegExp.test(itemPath)}`);
                if (!isFilePatternMatched(itemPath, promoteIgnoreList)) {
                    if (item.folder) {
                        // it is a folder
                        gbFolders.push(itemPath);
                    } else if (pathsToSelectRegExp.test(itemPath)) {
                        const downloadUrl = `${downloadBaseURI}/${item.id}/content`;
                        // eslint-disable-next-line no-await-in-loop
                        gbFiles.push({ fileDownloadUrl: downloadUrl, filePath: itemPath });
                    }
                } else {
                    logger.info(`Ignored from promote: ${itemPath}`);
                }
            }
        }
    }
    return gbFiles;
}

function exitAction(resp) {
    appConfig.removePayload();
    return resp;
}

exports.main = main;
