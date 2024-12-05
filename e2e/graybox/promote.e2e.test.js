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

const { Config } = require('@adobe/aio-sdk').Core;
const fetch = require('node-fetch');

// get action url
const namespace = Config.get('runtime.namespace');
const hostname = Config.get('cna.hostname') || 'adobeioruntime.net';
const runtimePackage = 'graybox';
const actionUrl = `https://${namespace}.${hostname}/api/v1/web/${runtimePackage}/promote`;

test('returns a 204 as promote calls async initiate-promote-worker action', async () => {
    const res = await fetch(actionUrl);
    expect(res).toEqual(expect.objectContaining({
        status: 204
    }));
});
