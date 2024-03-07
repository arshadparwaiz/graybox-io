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

jest.mock('@adobe/aio-sdk', () => ({
    Core: {
        Logger: jest.fn()
    }
}));

const { Core } = require('@adobe/aio-sdk');

const mockLoggerInstance = { info: jest.fn(), debug: jest.fn(), error: jest.fn() };
Core.Logger.mockReturnValue(mockLoggerInstance);

jest.mock('node-fetch');
const action = require('../../actions/graybox/promote');

beforeEach(() => {
    Core.Logger.mockClear();
    mockLoggerInstance.info.mockReset();
    mockLoggerInstance.debug.mockReset();
    mockLoggerInstance.error.mockReset();
});

describe('promote', () => {
    test('main should be defined', () => {
        expect(action.main).toBeInstanceOf(Function);
    });
});
