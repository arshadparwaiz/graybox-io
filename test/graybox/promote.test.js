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

const openwhisk = require('openwhisk');
const { getAioLogger } = require('../../actions/utils');
const { validateAction } = require('../../actions/graybox/validateAction');
const AppConfig = require('../../actions/appConfig');
const { main } = require('../../actions/graybox/promote');

jest.mock('openwhisk');
jest.mock('../../actions/utils');
jest.mock('../../actions/graybox/validateAction');
jest.mock('../../actions/appConfig');

describe('main function', () => {
    let loggerMock;
    let owMock;

    beforeEach(() => {
        loggerMock = {
            info: jest.fn(),
            error: jest.fn()
        };
        getAioLogger.mockReturnValue(loggerMock);

        owMock = {
            actions: {
                invoke: jest.fn()
            }
        };
        openwhisk.mockReturnValue(owMock);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('should return a 200 response on successful invocation', async () => {
        const params = { some: 'params' };
        const appConfigInstance = {
            getConfig: jest.fn().mockReturnValue({ grayboxUserGroups: ['group1'] }),
            ignoreUserCheck: jest.fn().mockReturnValue(false)
        };
        AppConfig.mockImplementation(() => appConfigInstance);

        validateAction.mockResolvedValue({ code: 200 });

        owMock.actions.invoke.mockResolvedValue('invoke-result');

        const result = await main(params);

        expect(loggerMock.info).toHaveBeenCalledWith('Graybox Promote action invoked');
        expect(validateAction).toHaveBeenCalledWith(params, ['group1'], false);
        expect(owMock.actions.invoke).toHaveBeenCalledWith({
            name: 'graybox/promote-worker',
            blocking: false,
            result: false,
            params
        });
        expect(loggerMock.info).toHaveBeenCalledWith('invoke-result');
        expect(result).toEqual({
            code: 200,
            payload: 'Graybox Promote action invoked'
        });
    });

    it('should return validation error response if validation fails', async () => {
        const params = { some: 'params' };
        const appConfigInstance = {
            getConfig: jest.fn().mockReturnValue({ grayboxUserGroups: ['group1'] }),
            ignoreUserCheck: jest.fn().mockReturnValue(false)
        };
        AppConfig.mockImplementation(() => appConfigInstance);

        validateAction.mockResolvedValue({ code: 400, message: 'Validation failed' });

        const result = await main(params);

        expect(loggerMock.info).toHaveBeenCalledWith('Graybox Promote action invoked');
        expect(validateAction).toHaveBeenCalledWith(params, ['group1'], false);
        expect(loggerMock.info).toHaveBeenCalledWith('Validation failed: {"code":400,"message":"Validation failed"}');
        expect(result).toEqual({ code: 400, message: 'Validation failed' });
    });

    it('should return a 500 response if invocation fails', async () => {
        const params = { some: 'params' };
        const appConfigInstance = {
            getConfig: jest.fn().mockReturnValue({ grayboxUserGroups: ['group1'] }),
            ignoreUserCheck: jest.fn().mockReturnValue(false)
        };
        AppConfig.mockImplementation(() => appConfigInstance);

        validateAction.mockResolvedValue({ code: 200 });

        owMock.actions.invoke.mockRejectedValue(new Error('Invocation error'));

        const result = await main(params);

        expect(loggerMock.info).toHaveBeenCalledWith('Graybox Promote action invoked');
        expect(validateAction).toHaveBeenCalledWith(params, ['group1'], false);
        expect(loggerMock.error).toHaveBeenCalledWith('Failed to invoke graybox promote action: Error: Invocation error');
        expect(result).toEqual({
            code: 500,
            payload: 'Failed to invoke graybox promote action'
        });
    });

    it('should return a 500 response on unknown error', async () => {
        const params = { some: 'params' };
        const appConfigInstance = {
            getConfig: jest.fn().mockReturnValue({ grayboxUserGroups: ['group1'] }),
            ignoreUserCheck: jest.fn().mockReturnValue(false)
        };
        AppConfig.mockImplementation(() => appConfigInstance);

        validateAction.mockImplementation(() => {
            throw new Error('Unknown error');
        });

        const result = await main(params);

        expect(loggerMock.info).toHaveBeenCalledWith('Graybox Promote action invoked');
        expect(loggerMock.error).toHaveBeenCalledWith('Unknown error occurred: Error: Unknown error');
        expect(result).toEqual({
            code: 500,
            payload: new Error('Unknown error')
        });
    });
});
