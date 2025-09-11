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

/**
 * Test file demonstrating the enhanced bulk copy system
 * This shows how the system processes URLs and discovers fragments
 */

// Example source paths that would be sent to the bulk copy system
const exampleSourcePaths = [
    'https://example.aem.page/path/to/page1',
    'https://example.aem.page/path/to/page2',
    'https://example.aem.page/path/to/page3',
    'https://example.aem.page/path/to/page4'
];

// Example of what the system would discover for each page
const exampleFragmentDiscovery = {
    'https://example.aem.page/path/to/page1': {
        hasFragments: true,
        fragments: [
            {
                fragmentPath: 'https://example.aem.page/path/to/fragments/fragment1',
                status: 200,
                availability: 'Available',
                nestedFragments: [
                    {
                        fragmentPath: 'https://example.aem.page/path/to/fragments/nested-fragment1',
                        status: 200,
                        availability: 'Available'
                    }
                ],
                nestedFragmentCount: 1
            }
        ],
        fragmentCount: 1
    },
    'https://example.aem.page/path/to/page2': {
        hasFragments: false,
        fragments: [],
        fragmentCount: 0
    },
    'https://example.aem.page/path/to/page3': {
        hasFragments: true,
        fragments: [
            {
                fragmentPath: 'https://example.aem.page/path/to/fragments/fragment2',
                status: 200,
                availability: 'Available',
                nestedFragments: [],
                nestedFragmentCount: 0
            },
            {
                fragmentPath: 'https://example.aem.page/path/to/fragments/fragment3',
                status: 404,
                availability: 'Missing',
                nestedFragments: [],
                nestedFragmentCount: 0
            }
        ],
        fragmentCount: 2
    },
    'https://example.aem.page/path/to/page4': {
        hasFragments: false,
        fragments: [],
        fragmentCount: 0
    }
};

// Example of the categorization that would be created
const exampleCategorization = {
    'bulkcopy-to-be-processed.json': [
        {
            sourcePath: 'https://example.aem.page/path/to/page1',
            destinationPath: '/experienceName/https://example.aem.page/path/to/page1',
            hasFragments: true,
            fragments: exampleFragmentDiscovery['https://example.aem.page/path/to/page1'].fragments,
            fragmentCount: 1,
            type: 'page'
        },
        {
            sourcePath: 'https://example.aem.page/path/to/page3',
            destinationPath: '/experienceName/https://example.aem.page/path/to/page3',
            hasFragments: true,
            fragments: exampleFragmentDiscovery['https://example.aem.page/path/to/page3'].fragments,
            fragmentCount: 2,
            type: 'page'
        }
    ],
    'bulkcopy-not-processed.json': [
        {
            sourcePath: 'https://example.aem.page/path/to/page2',
            destinationPath: '/experienceName/https://example.aem.page/path/to/page2',
            hasFragments: false,
            fragments: [],
            fragmentCount: 0,
            type: 'page'
        },
        {
            sourcePath: 'https://example.aem.page/path/to/page4',
            destinationPath: '/experienceName/https://example.aem.page/path/to/page4',
            hasFragments: false,
            fragments: [],
            fragmentCount: 0,
            type: 'page'
        }
    ]
};

// Example of how batches would be created
const exampleBatching = {
    'batch_1.json': exampleCategorization['bulkcopy-to-be-processed.json'].slice(0, 2),
    'batch_status.json': {
        'batch_1': 'initiated'
    },
    'bulk_copy_batches.json': {
        'batch_1': exampleCategorization['bulkcopy-to-be-processed.json'].slice(0, 2)
    }
};

// Example of the Excel updates that would be generated
const exampleExcelUpdates = [
    ['Bulk Copy Fragment Discovery Completed', '2024-01-01T00:00:00.000Z', '', ''],
    ['Total files processed: 4', '2024-01-01T00:00:00.000Z', '', ''],
    ['Files with fragments: 2', '2024-01-01T00:00:00.000Z', '', ''],
    ['Files without fragments: 2', '2024-01-01T00:00:00.000Z', '', ''],
    ['Batches created: 1', '2024-01-01T00:00:00.000Z', '', '']
];

console.log('Enhanced Bulk Copy System Test');
console.log('==============================');
console.log('');
console.log('Example source paths:', exampleSourcePaths);
console.log('');
console.log('Fragment discovery results:', JSON.stringify(exampleFragmentDiscovery, null, 2));
console.log('');
console.log('File categorization:', JSON.stringify(exampleCategorization, null, 2));
console.log('');
console.log('Batch creation:', JSON.stringify(exampleBatching, null, 2));
console.log('');
console.log('Excel updates:', JSON.stringify(exampleExcelUpdates, null, 2));

export { exampleSourcePaths, exampleFragmentDiscovery, exampleCategorization, exampleBatching, exampleExcelUpdates };
