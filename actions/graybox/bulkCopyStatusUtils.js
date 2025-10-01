/* ************************************************************************
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

import { toUTCStr, getAioLogger } from '../utils.js';

const logger = getAioLogger();

/**
 * Initialize bulk copy status structure
 * @param {*} project project path
 * @param {*} experienceName experience name
 * @param {*} totalSourcePaths total number of source paths
 * @returns initial status structure
 */
export function initializeBulkCopyStatus(project, experienceName, totalSourcePaths) {
    return {
        project,
        experienceName,
        overallStatus: 'initiated',
        startTime: toUTCStr(new Date()),
        endTime: null,
        totalSourcePaths,
        steps: {
            step1_discovery: {
                name: 'File Discovery and Batch Organization',
                status: 'pending',
                startTime: null,
                endTime: null,
                progress: {
                    total: 0,
                    completed: 0,
                    failed: 0
                },
                details: {
                    totalBatches: 0,
                    processingBatches: 0,
                    nonProcessingBatches: 0,
                    totalFragments: 0,
                    totalNestedFragments: 0
                },
                errors: []
            },
            step2_non_processing_copy: {
                name: 'Non-Processing Files Copy',
                status: 'pending',
                startTime: null,
                endTime: null,
                progress: {
                    total: 0,
                    completed: 0,
                    failed: 0
                },
                details: {
                    copiedFiles: [],
                    failedFiles: []
                },
                errors: []
            },
            step3_docx_processing: {
                name: 'DOCX Content Processing',
                status: 'pending',
                startTime: null,
                endTime: null,
                progress: {
                    total: 0,
                    completed: 0,
                    failed: 0
                },
                details: {
                    processedFiles: [],
                    failedFiles: [],
                    transformedFragments: 0
                },
                errors: []
            },
            step4_promotion: {
                name: 'Processed Files Copy',
                status: 'pending',
                startTime: null,
                endTime: null,
                progress: {
                    total: 0,
                    completed: 0,
                    failed: 0
                },
                details: {
                    promotedFiles: [],
                    failedFiles: []
                },
                errors: []
            },
            step5_preview: {
                name: 'Preview of Copied Files',
                status: 'pending',
                startTime: null,
                endTime: null,
                progress: {
                    total: 0,
                    completed: 0,
                    failed: 0
                },
                details: {
                    previewedFiles: [],
                    promotedFiles: [],
                    copiedFiles: [],
                    failedFiles: []
                },
                errors: []
            }
        },
        summary: {
            totalFiles: 0,
            successfulFiles: 0,
            failedFiles: 0,
            totalFragments: 0,
            totalBatches: 0
        }
    };
}

/**
 * Update bulk copy status for a specific step
 * @param {*} filesWrapper filesWrapper object
 * @param {*} project project path
 * @param {*} stepKey step key (e.g., 'step1_discovery')
 * @param {*} updates updates to apply to the step
 */
export async function updateBulkCopyStepStatus(filesWrapper, project, stepKey, updates) {
    try {
        logger.info(`Updating bulk copy step status for project: ${project}, step: ${stepKey}, updates: ${JSON.stringify(updates)}`);
        const statusPath = `graybox_promote${project}/bulk-copy-status.json`;
        let status = {};
        try {
            const existingStatus = await filesWrapper.readFileIntoObject(statusPath);
            if (existingStatus && typeof existingStatus === 'object') {
                status = existingStatus;
                logger.info(`Loaded existing status file for project ${project}`);
            }
        } catch (err) {
            // File doesn't exist yet, will create new one
            logger.info(`Status file doesn't exist yet for project ${project}, will create new one`);
        }

        // Ensure steps object exists
        if (!status.steps) {
            status.steps = {};
        }

        // Ensure the specific step exists
        if (!status.steps[stepKey]) {
            status.steps[stepKey] = {
                status: 'pending',
                startTime: null,
                endTime: null,
                progress: { total: 0, completed: 0, failed: 0 },
                details: {},
                errors: []
            };
        }

        // Ensure all required properties exist
        if (!status.steps[stepKey].progress) {
            status.steps[stepKey].progress = { total: 0, completed: 0, failed: 0 };
        }
        if (!status.steps[stepKey].details) {
            status.steps[stepKey].details = {};
        }
        if (!status.steps[stepKey].errors) {
            status.steps[stepKey].errors = [];
        }

        // Apply updates
        Object.keys(updates).forEach((key) => {
            try {
                if (key === 'progress' && typeof updates[key] === 'object') {
                    // Merge progress updates
                    status.steps[stepKey].progress = { ...status.steps[stepKey].progress, ...updates[key] };
                } else if (key === 'details' && typeof updates[key] === 'object') {
                    // Merge details updates
                    status.steps[stepKey].details = { ...status.steps[stepKey].details, ...updates[key] };
                } else if (key === 'errors' && Array.isArray(updates[key])) {
                    // Append errors
                    if (!status.steps[stepKey].errors) {
                        status.steps[stepKey].errors = [];
                    }
                    status.steps[stepKey].errors = [...status.steps[stepKey].errors, ...updates[key]];
                } else {
                    // Direct assignment
                    status.steps[stepKey][key] = updates[key];
                }
            } catch (updateErr) {
                logger.error(`Error updating ${key}: ${updateErr.message}`);
                // Continue with other updates
            }
        });

        // Update overall status based on step status
        await updateOverallStatus(status);

        // Write updated status
        await filesWrapper.writeFile(statusPath, status);
        logger.info(`Successfully updated bulk copy step status for ${stepKey} in project ${project}`);
    } catch (err) {
        logger.error(`Error updating bulk copy step status: ${err.message}`);
        logger.error(`Error stack: ${err.stack}`);
    }
}

/**
 * Update overall status based on individual step statuses
 * @param {*} status status object
 */
async function updateOverallStatus(status) {
    const stepStatuses = Object.values(status.steps || {}).map((step) => step.status);

    if (stepStatuses.includes('failed')) {
        status.overallStatus = 'failed';
    } else if (stepStatuses.includes('in_progress')) {
        status.overallStatus = 'in_progress';
    } else if (stepStatuses.every((stepStatus) => stepStatus === 'completed')) {
        status.overallStatus = 'completed';
        status.endTime = toUTCStr(new Date());
    } else if (stepStatuses.some((stepStatus) => stepStatus === 'completed')) {
        status.overallStatus = 'in_progress';
    } else {
        status.overallStatus = 'pending';
    }

    // Update summary
    updateSummary(status);
}

/**
 * Update summary statistics
 * @param {*} status status object
 */
function updateSummary(status) {
    const steps = status.steps || {};

    // Calculate totals from all steps
    let totalFiles = 0;
    let successfulFiles = 0;
    let failedFiles = 0;
    let totalFragments = 0;
    let totalBatches = 0;

    Object.values(steps).forEach((step) => {
        if (step.progress) {
            totalFiles += step.progress.total || 0;
            successfulFiles += step.progress.completed || 0;
            failedFiles += step.progress.failed || 0;
        }

        if (step.details) {
            totalFragments += step.details.totalFragments || 0;
            totalBatches += step.details.totalBatches || 0;
        }
    });

    status.summary = {
        totalFiles,
        successfulFiles,
        failedFiles,
        totalFragments,
        totalBatches
    };
}

/**
 * Get bulk copy status for a project
 * @param {*} filesWrapper filesWrapper object
 * @param {*} project project path
 * @returns status object
 */
export async function getBulkCopyStatus(filesWrapper, project) {
    try {
        const statusPath = `graybox_promote${project}/bulk-copy-status.json`;
        return await filesWrapper.readFileIntoObject(statusPath);
    } catch (err) {
        return null;
    }
}
