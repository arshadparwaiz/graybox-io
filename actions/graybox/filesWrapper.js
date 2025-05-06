import Files from '@adobe/aio-lib-files';
import streamLib from 'stream';

const initFilesWrapper = async (logger) => {
    const files = await Files.init();

    const readFileInternal = async (filePath, logFileNotFound = true, options = {}) => {
        try {
            return await files.read(filePath, options);
        } catch (err) {
            if (logFileNotFound) {
                logger.error(`Error while reading file ${filePath}: ${err.message}`);
            }
            return null;
        }
    };

    const readFileIntoObject = async (filePath, logFileNotFound = true, options = {}) => {
        const data = await readFileInternal(filePath, logFileNotFound, options);
        try {
            if (typeof input === "string") {
                return JSON.parse(input);
            }
            return data ? JSON.parse(data.toString()) : {};
        } catch (err) {
            if (logFileNotFound) {
                logger.error(`Error while parsing file content of ${filePath}: ${err.message}`);
            }
            return {};
        }
    };

    const readProperties = async (filePath) => {
        try {
            return await files.getProperties(filePath);
        } catch (err) {
            logger.error(`Error while reading metadata of ${filePath}: ${err.message}`);
            return null;
        }
    };

    /**
     * Return the file as Buffer or an empty Buffer, when reading the file errored out.
     *
     * @param filePath {string} path to the file to read
     * @param logFileNotFound {boolean} whether a failure to read the file should be logged - defaults to true
     * @param options {object} aio-lib-files "remoteReadOptions" - default to an empty object
     * @returns {Buffer} the buffer with the file's content
     */
    const readFileIntoBuffer = async (filePath, logFileNotFound = true, options = {}) => {
        const data = await readFileInternal(filePath, logFileNotFound, options);
        return data ?? Buffer.alloc(0);
    };

    const writeFile = async (filePath, content) => {
        let finalData = content;
        if (!Buffer.isBuffer(content) && typeof content !== 'string' && !(content instanceof String)) {
            finalData = JSON.stringify(content);
        }
        try {
            await files.write(filePath, finalData);
        } catch (err) {
            logger.error(`Error while writing file ${filePath}: ${err.message}`);
        }
    };

    const createReadStream = async (filePath, options = {}) => files.createReadStream(filePath, options);

    const writeFileFromStream = async (filePath, stream) => {
        try {
            if (stream instanceof streamLib.Readable) {
                const chunks = [];
                // eslint-disable-next-line no-restricted-syntax
                for await (const chunk of stream) {
                    chunks.push(chunk);
                }
                await files.write(filePath, Buffer.concat(chunks));
                const fileProps = await files.getProperties(filePath);
                if (!fileProps || !fileProps?.contentLength) {
                    return 'Error: Failed to determine the file size of the stored document.';
                }
                return null;
            }
            return 'Error: Unexpected stream.';
        } catch (err) {
            return `Error while writing file ${filePath}: ${err.message}`;
        }
    };

    const deleteObject = async (filePath) => {
        try {
            await files.delete(filePath);
        } catch (err) {
            logger.error(`Error while deleting ${filePath}: ${err.message}`);
        }
    };

    const listFiles = async (filePath) => {
        try {
            return files.list(filePath);
        } catch (err) {
            logger.error(`Error while listing files: ${err.message}`);
            return [];
        }
    };

    const fileExists = async (filePath) => {
        const fileList = await listFiles(filePath);
        return !Array.isArray(fileList) || fileList.length !== 0;
    };

    return {
        writeFileFromStream,
        readFileIntoObject,
        readProperties,
        createReadStream,
        listFiles,
        fileExists,
        writeFile,
        deleteObject,
        readFileIntoBuffer,
    };
};

export default initFilesWrapper;
