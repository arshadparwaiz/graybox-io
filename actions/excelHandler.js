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

import xlsx from 'xlsx';
import { getAioLogger } from './utils.js';

const logger = getAioLogger();

const gbDomainSuffix = '-graybox';
const emptyString = '';

/**
 * Process columns array by replacing experiment name and graybox suffix
 */
function processColumns(columns, expName) {
    if (!columns || !Array.isArray(columns)) return;
    
    for (let i = 0; i < columns.length; i += 1) {
        const column = columns[i];
        if (typeof column === 'string' && (column.includes(expName) || column.includes(gbDomainSuffix))) {
            columns[i] = column.replaceAll(`/${expName}/`, '/').replaceAll(gbDomainSuffix, emptyString);
        }
    }
}

/**
 * Process data rows by replacing experiment name and graybox suffix
 */
function processDataRows(data, expName) {
    if (!data || !Array.isArray(data)) return;
    
    data.forEach((row) => {
        if (Array.isArray(row)) {
            for (let i = 0; i < row.length; i += 1) {
                const cell = row[i];
                if (typeof cell === 'string' && (cell.includes(expName) || cell.includes(gbDomainSuffix))) {
                    row[i] = cell.replaceAll(`/${expName}/`, '/').replaceAll(gbDomainSuffix, emptyString);
                }
            }
        } else if (typeof row === 'object' && row !== null) {
            // Handle object rows
            Object.keys(row).forEach((key) => {
                const cell = row[key];
                if (typeof cell === 'string' && (cell.includes(expName) || cell.includes(gbDomainSuffix))) {
                    row[key] = cell.replaceAll(`/${expName}/`, '/').replaceAll(gbDomainSuffix, emptyString);
                }
            });
        } else {
            logger.info(`In updateExcel - processing excel is not array or object`);
        }
    });
}

/**
 * Process a single sheet's data
 */
function processSheetData(sheetData, expName) {
    processColumns(sheetData.columns, expName);
    processDataRows(sheetData.data, expName);
}

/**
 * Create a worksheet from sheet data
 */
function createWorksheetFromSheetData(sheetData) {
    let worksheet;
    if (sheetData.columns && (sheetData.data || Array.isArray(sheetData.data))) {
        // Create worksheet from columns and data arrays
        const rows = [sheetData.columns];
        if (Array.isArray(sheetData.data)) {
            // If data is an array of objects, convert each object to an array in the same order as columns
            if (sheetData.data.length > 0 && typeof sheetData.data[0] === 'object' && !Array.isArray(sheetData.data[0])) {
                sheetData.data.forEach((dataObj) => {
                    const row = sheetData.columns.map((col) => dataObj[col] || '');
                    rows.push(row);
                });
            } else {
                // If data is already an array of arrays, just add them
                rows.push(...sheetData.data);
            }
        }
        worksheet = xlsx.utils.aoa_to_sheet(rows);
    } else {
        // Fallback if structure is different
        const dataArray = Array.isArray(sheetData) ? sheetData : [sheetData];
        worksheet = xlsx.utils.json_to_sheet(dataArray);
    }
    return worksheet;
}

/**
 * Process multi-sheet format
 */
function processMultiSheetFormat(parsedContent, workbook) {
    // Process each sheet defined in :names array
    parsedContent[':names'].forEach((sheetName) => {
        if (parsedContent[sheetName]) {
            const sheetData = parsedContent[sheetName];
            const worksheet = createWorksheetFromSheetData(sheetData);
            // Add the worksheet to the workbook with the sheet name prefixed with "helix-"
            const prefixedSheetName = `helix-${sheetName}`;
            xlsx.utils.book_append_sheet(workbook, worksheet, prefixedSheetName);
        }
    });
}

/**
 * Process single sheet format
 */
function processSingleSheetFormat(parsedContent, workbook) {
    let worksheet;
    if (parsedContent.columns && parsedContent.data) {
        // Create worksheet from columns and data arrays
        // Ensure parsedContent.data is an array of arrays
        const rows = [parsedContent.columns];
        if (Array.isArray(parsedContent.data)) {
            // If data is an array of objects, convert each object to an array in the same order as columns
            if (parsedContent.data.length > 0 && typeof parsedContent.data[0] === 'object' && !Array.isArray(parsedContent.data[0])) {
                parsedContent.data.forEach((dataObj) => {
                    const row = parsedContent.columns.map((col) => dataObj[col] || '');
                    rows.push(row);
                });
            } else {
                // If data is already an array of arrays, just add them
                rows.push(...parsedContent.data);
            }
        }
        worksheet = xlsx.utils.aoa_to_sheet(rows);
    } else {
        // If the data is an array of objects, convert it directly
        const dataArray = Array.isArray(parsedContent) ? parsedContent : [parsedContent];
        worksheet = xlsx.utils.json_to_sheet(dataArray);
    }
    // Add the worksheet to the workbook
    xlsx.utils.book_append_sheet(workbook, worksheet, 'helix-default');
}

export async function updateExcel(content, expName) {
    try {
        // Parse the content as JSON
        const jsonContent = typeof content === 'string' ? JSON.parse(content) : content;
        
        // Handle multi-sheet format
        if (jsonContent[':type'] === 'multi-sheet' && jsonContent[':names'] && Array.isArray(jsonContent[':names'])) {
            // Process each sheet defined in :names array
            jsonContent[':names'].forEach((sheetName) => {
                if (jsonContent[sheetName]) {
                    processSheetData(jsonContent[sheetName], expName);
                }
            });
        } else {
            // Handle single sheet format (original implementation)
            processSheetData(jsonContent, expName);
        }
        
        return JSON.stringify(jsonContent);
    } catch (err) {
        logger.error(`Error while updating Excel content: ${err}`);
        return content; // Return original content if there's an error
    }
}

/**
 * Convert JSON content to Excel format.
 * @param {Object} jsonContent - The JSON content to convert.
 * @returns {Buffer} - The converted Excel content.
 */
export function convertJsonToExcel(jsonContent, expName) {
    try {
        // Parse JSON string if it's a string
        const parsedContent = typeof jsonContent === 'string' ? JSON.parse(jsonContent) : jsonContent;
        // Create a workbook
        const workbook = xlsx.utils.book_new();
        
        // Handle multi-sheet format
        if (parsedContent[':type'] === 'multi-sheet' && parsedContent[':names'] && Array.isArray(parsedContent[':names'])) {
            processMultiSheetFormat(parsedContent, workbook);
        } else {
            // Handle single sheet format (original implementation)
            processSingleSheetFormat(parsedContent, workbook);
        }
        
        // Write to buffer
        const excelBuffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
        return excelBuffer;
    } catch (error) {
        logger.error(`Error in convertJsonToExcel: ${error}`);
        // Create a simple empty workbook as fallback
        const workbook = xlsx.utils.book_new();
        const worksheet = xlsx.utils.aoa_to_sheet([['Error converting JSON to Excel']]);
        xlsx.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
        return xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    }
}
