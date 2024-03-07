const { validateAction } = require('../../actions/graybox/validateAction'); // Update the path accordingly
const GrayboxUser = require('../../actions/grayboxUser');

const validParams = {
    rootFolder: '/app',
    gbRootFolder: '/app-graybox',
    projectExcelPath: '/path/to/excel.xlsx',
    experienceName: '/max',
    spToken: 'abcde',
    adminPageUri: 'https://adobe.com',
    draftsOnly: true,
    promoteIgnorePaths: '/path1'
};

// Mock GrayboxUser class and its methods
jest.mock('../../actions/grayboxUser', () => {
    return jest.fn().mockImplementation(() => {
        return {
            isInGroups: jest.fn().mockResolvedValue(true)
        };
    });
});

describe('validateAction', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('should return 400 if required params are missing', async () => {
        const params = {
            // Missing some required parameters
        };
        const grpIds = [];
        const result = await validateAction(params, grpIds);
        expect(result.code).toBe(400);
    });

    test('should return 401 if user is not authorized', async () => {
        const params = validParams;
        const grpIds = [];
        GrayboxUser.mockImplementation(() => {
            return {
                isInGroups: jest.fn().mockResolvedValue(false) // Mocking user not authorized
            };
        });
        const result = await validateAction(params, grpIds);
        expect(result.code).toBe(401);
    });

    test('should return 200 if user is authorized and all required params are present', async () => {
        const params = validParams;
        const grpIds = [];
        GrayboxUser.mockImplementation(() => {
            return {
                isInGroups: jest.fn().mockResolvedValue(true) // Mocking user not authorized
            };
        });
        const result = await validateAction(params, grpIds);
        expect(result.code).toBe(200);
    });

    test('should return 200 if ignoreUserCheck is true', async () => {
        const params = validParams;
        const grpIds = [];
        const result = await validateAction(params, grpIds, true);
        expect(result.code).toBe(200);
        // GrayboxUser constructor should not get called
        expect(GrayboxUser).not.toHaveBeenCalled();
    });
});
