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
const action = require('../../actions/graybox/promote');
const { getAioLogger } = require('../../actions/utils');
const { validateAction } = require('../../actions/graybox/validateAction');
const appConfig = require('../../actions/appConfig');

jest.mock('openwhisk');
jest.mock('../../actions/utils');
jest.mock('../../actions/graybox/validateAction');
jest.mock('../../actions/appConfig');

describe('main function', () => {
    let loggerMock;
    let owMock;
    let params;

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
        validateAction.mockReturnValue({ code: 200 });

        appConfig.setAppConfig.mockImplementation(() => {
            appConfig.getConfig.mockReturnValue({
                grayboxUserGroups: ['group1', 'group2']
            });
        });

        params = {
            // mock params
        };
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    test('invokes graybox promote action successfully', async () => {
        appConfig.ignoreUserCheck.mockReturnValue(false);
        owMock.actions.invoke.mockResolvedValue({
            result: {
                code: 200,

            }
        });

        const result = await action.main(params);
        const msg = 'Graybox Promote action invoked';
        expect(loggerMock.info).toHaveBeenCalledWith(msg);
        expect(validateAction).toHaveBeenCalledWith(params, ['group1', 'group2'], false);
        expect(owMock.actions.invoke).toHaveBeenCalledWith({
            name: 'graybox/promote-worker',
            blocking: false,
            result: false,
            params
        });
        expect(result).toEqual({ code: 200, payload: msg });
    });

    test('handles validation failure', async () => {
        validateAction.mockReturnValue({ code: 400 });

        const result = await action.main(params);

        expect(loggerMock.info).toHaveBeenCalledWith(expect.stringContaining('Validation failed'));
        expect(result).toEqual({ code: 400 });
    });

    test('handles graybox promote action invocation failure', async () => {
        const errMsg = 'Failed to invoke graybox promote action';
        owMock.actions.invoke.mockRejectedValue(new Error(errMsg));

        const result = await action.main(params);

        expect(loggerMock.error).toHaveBeenCalledWith(expect.stringContaining(errMsg));
        expect(result).toEqual({ code: 500, payload: errMsg });
    });

    test('handles unknown error', async () => {
        const errMsg = 'Unknown error occurred';
        validateAction.mockRejectedValue(new Error(errMsg));

        const result = await action.main(params);

        expect(loggerMock.error).toHaveBeenCalledWith(expect.stringContaining(errMsg));
        expect(result).toEqual({ code: 500, payload: new Error(errMsg) });
    });
});
