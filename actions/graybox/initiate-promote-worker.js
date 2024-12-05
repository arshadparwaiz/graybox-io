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

const initFilesWrapper = require('./filesWrapper');
const {
    getAioLogger, isFilePatternMatched, toUTCStr
} = require('../utils');
const AppConfig = require('../appConfig');
const Sharepoint = require('../sharepoint');

const logger = getAioLogger();
const MAX_CHILDREN = 1000;
const BATCH_REQUEST_PREVIEW = 200;
// const BATCH_REQUEST_PREVIEW = 1; // TODO remove this line and uncomment the above line after testing

/**
 *  - Bulk Preview Graybox files
 *  - GET markdown files using preview-url.md
 *  - Process markdown - process MDAST by cleaning it up
 *  - Generate updated Docx file using md2docx lib
 *  - copy updated docx file to the default content tree
 *  - run the bulk preview action on the list of files that were copied to default content tree
 *  - update the project excel file as and when necessary to update the status of the promote action
 */
async function main(params) {
    logger.info('Graybox Initiate Promote Worker invoked');

    const appConfig = new AppConfig(params);
    const {
        adminPageUri, rootFolder, gbRootFolder, promoteIgnorePaths, experienceName, projectExcelPath, draftsOnly
    } = appConfig.getPayload();

    const filesWrapper = await initFilesWrapper(logger);
    const sharepoint = new Sharepoint(appConfig);

    try {
        // Update Promote Status
        const promoteTriggeredExcelValues = [['Promote triggered', toUTCStr(new Date()), '']];
        await sharepoint.updateExcelTable(projectExcelPath, 'PROMOTE_STATUS', promoteTriggeredExcelValues);
    } catch (err) {
        logger.error(`Error Occured while updating Excel during Graybox Initiate Promote: ${err}`);
    }

    logger.info(`GB ROOT FOLDER ::: ${gbRootFolder}`);
    logger.info(`GB EXP NAME ::: ${experienceName}`);

    // Get all files in the graybox folder for the specific experience name
    // NOTE: This does not capture content inside the locale/expName folders yet
    const gbFiles = await findAllFiles(experienceName, appConfig, sharepoint);

    // Create Batch Status JSON
    const batchStatusJson = {};

    // Create Project Preview Status JSON
    const previewStatusJson = [];

    // Create GBFiles Batches JSON
    const gbFileBatchesJson = {};

    // Preview Errors JSON
    const projectPreviewErrorsJson = [];

    // Promoted Paths JSON
    const promotedPathsJson = {};

    // Promote Errors JSON
    const promoteErrorsJson = [];

    // Copy Batches JSON
    const copyBatchesJson = {};

    // Promote Batches JSON
    const promoteBatchesJson = {};

    // create batches to process the data
    const gbFilesBatchArray = [];
    const writeBatchJsonPromises = [];
    for (let i = 0, batchCounter = 1; i < gbFiles.length; i += BATCH_REQUEST_PREVIEW, batchCounter += 1) {
        const arrayChunk = gbFiles.slice(i, i + BATCH_REQUEST_PREVIEW);
        gbFilesBatchArray.push(arrayChunk);
        const batchName = `batch_${batchCounter}`;
        batchStatusJson[`${batchName}`] = 'initiated';

        // Each Files Batch is written to a batch_n.json file
        writeBatchJsonPromises.push(filesWrapper.writeFile(`graybox_promote${gbRootFolder}/${experienceName}/batches/${batchName}.json`, arrayChunk));

        // Write the GBFile Batches to the gbfile_batches.json file
        gbFileBatchesJson[batchName] = arrayChunk;
    }

    await Promise.all(writeBatchJsonPromises);

    const inputParams = {};
    inputParams.rootFolder = rootFolder;
    inputParams.gbRootFolder = gbRootFolder;
    inputParams.projectExcelPath = projectExcelPath;
    inputParams.experienceName = experienceName;
    inputParams.adminPageUri = adminPageUri;
    inputParams.draftsOnly = draftsOnly;
    inputParams.promoteIgnorePaths = promoteIgnorePaths;

    // convert the ignoreUserCheck boolean to string, so the string processing in the appConfig -> ignoreUserCheck works
    inputParams.ignoreUserCheck = `${appConfig.ignoreUserCheck()}`;

    // Create Project Queue Json
    let projectQueue = [];
    // Read the existing Project Queue Json & then merge the current project to it
    if (await filesWrapper.fileExists('graybox_promote/project_queue.json')) {
        projectQueue = await filesWrapper.readFileIntoObject('graybox_promote/project_queue.json');
        if (!projectQueue) {
            projectQueue = [];
        }
    }

    const newProject = { projectPath: `${gbRootFolder}/${experienceName}`, status: 'initiated', createdTime: Date.now() };

    // TODO - check if replacing existing project is needed, if not remove this logic and just add the project to the queue
    // Find the index of the same  experience Project exists, replace it with this one
    const index = projectQueue.findIndex((obj) => obj.projectPath === `${gbRootFolder}/${experienceName}`);
    if (index !== -1) {
        // Replace the object at the found index
        projectQueue[index] = newProject;
    } else {
        // Add the current project to the Project Queue Json & make it the current project
        projectQueue.push(newProject);
    }

    logger.info(`In Initiate Promote Worker, Project Queue Json: ${JSON.stringify(projectQueue)}`);

    // Create Project Status JSON
    const projectStatusJson = { status: 'initiated', params: inputParams };

    logger.info(`In Initiate Promote Worker, projectStatusJson: ${JSON.stringify(projectStatusJson)}`);

    // write to JSONs to AIO Files for Projects Queue and Project Status
    await filesWrapper.writeFile('graybox_promote/project_queue.json', projectQueue);
    await filesWrapper.writeFile(`graybox_promote${gbRootFolder}/${experienceName}/status.json`, projectStatusJson);
    await filesWrapper.writeFile(`graybox_promote${gbRootFolder}/${experienceName}/gbfile_batches.json`, gbFileBatchesJson);
    await filesWrapper.writeFile(`graybox_promote${gbRootFolder}/${experienceName}/batch_status.json`, batchStatusJson);
    await filesWrapper.writeFile(`graybox_promote${gbRootFolder}/${experienceName}/preview_status.json`, previewStatusJson);
    await filesWrapper.writeFile(`graybox_promote${gbRootFolder}/${experienceName}/preview_errors.json`, projectPreviewErrorsJson);
    await filesWrapper.writeFile(`graybox_promote${gbRootFolder}/${experienceName}/promoted_paths.json`, promotedPathsJson);
    await filesWrapper.writeFile(`graybox_promote${gbRootFolder}/${experienceName}/promote_errors.json`, promoteErrorsJson);
    await filesWrapper.writeFile(`graybox_promote${gbRootFolder}/${experienceName}/promote_batches.json`, promoteBatchesJson);
    await filesWrapper.writeFile(`graybox_promote${gbRootFolder}/${experienceName}/copy_batches.json`, copyBatchesJson);

    // read Graybox Project Json from AIO Files
    const projectQueueJson = await filesWrapper.readFileIntoObject('graybox_promote/project_queue.json');
    logger.info(`In Initiate Promote Worker, Project Queue Json: ${JSON.stringify(projectQueueJson)}`);
    const statusJson = await filesWrapper.readFileIntoObject(`graybox_promote${gbRootFolder}/${experienceName}/status.json`);
    logger.info(`In Initiate Promote Worker, Project Status Json: ${JSON.stringify(statusJson)}`);
    const projectBatchStatusJson = await filesWrapper.readFileIntoObject(`graybox_promote${gbRootFolder}/${experienceName}/batch_status.json`);
    logger.info(`In Initiate Promote Worker, Project Batch Status Json: ${JSON.stringify(projectBatchStatusJson)}`);

    // process data in batches
    let responsePayload;
    responsePayload = 'Graybox Initiate Promote Worker action completed.';
    logger.info(responsePayload);
    return {
        body: responsePayload,
    };
}

/**
 * Find all files in the Graybox tree to promote.
 */
async function findAllFiles(experienceName, appConfig, sharepoint) {
    const sp = await appConfig.getSpConfig();
    const options = await sharepoint.getAuthorizedRequestOption({ method: 'GET' });
    const promoteIgnoreList = appConfig.getPromoteIgnorePaths();
    logger.info(`Promote ignore list: ${promoteIgnoreList}`);

    return findAllGrayboxFiles({
        baseURI: sp.api.file.get.gbBaseURI,
        options,
        gbFolders: appConfig.isDraftOnly() ? [`/${experienceName}/drafts`] : [''],
        promoteIgnoreList,
        downloadBaseURI: sp.api.file.download.baseURI,
        experienceName,
        sharepoint
    });
}

/**
 * Iteratively finds all files under a specified root folder.
 */
async function findAllGrayboxFiles({
    baseURI, options, gbFolders, promoteIgnoreList, downloadBaseURI, experienceName, sharepoint
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
        const res = await sharepoint.fetchWithRetry(uri, options);
        logger.info(`Find all Graybox files URI: ${uri} \nResponse: ${res.ok}`);
        if (res.ok) {
            // eslint-disable-next-line no-await-in-loop
            const json = await res.json();
            // eslint-disable-next-line no-await-in-loop
            const driveItems = json.value;
            for (let di = 0; di < driveItems?.length; di += 1) {
                const item = driveItems[di];
                const itemPath = `${item.parentReference.path.replace(pPathRegExp, '')}/${item.name}`;
                if (!isFilePatternMatched(itemPath, promoteIgnoreList)) {
                    if (item.folder) {
                        // it is a folder
                        gbFolders.push(itemPath);
                    } else if (pathsToSelectRegExp.test(itemPath)) {
                        // const downloadUrl = `${downloadBaseURI}/${item.id}/content`;
                        // eslint-disable-next-line no-await-in-loop
                        // gbFiles.push({ fileDownloadUrl: downloadUrl, filePath: itemPath });
                        gbFiles.push(itemPath);
                    }
                } else {
                    logger.info(`Ignored from promote: ${itemPath}`);
                }
            }
        }
    }
    return gbFiles;
}

exports.main = main;
