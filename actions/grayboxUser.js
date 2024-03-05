/* ***********************************************************************
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

const fetch = require('node-fetch');
const sharepointAuth = require('./sharepointAuth');
const appConfig = require('./appConfig');
const { getAioLogger } = require('./utils');

const logger = getAioLogger();

/**
 * GrayboxUser is based on the SP token and is used to check if the user is part of the required groups.
 * It uses the graph API to check the group membership of the user based on the group OID and user OID.
 * The group OID is configured in github env configs and read in the appConfig.
 * The user OID is obtained from the SP token.
 */
class GrayboxUser {
    constructor({ at }) {
        this.at = at;
        this.userDetails = sharepointAuth.getUserDetails(at);
        this.userOid = this.userDetails?.oid;
    }

    /**
     * Check if the user is part of the required groups.
     * @param {Array} grpIds - Array of group OIDs
     */
    async isInGroups(grpIds) {
        if (!grpIds?.length) return false;
        const appAt = await sharepointAuth.getAccessToken();
        // eslint-disable-next-line max-len
        const numGrps = grpIds.length;
        let url = appConfig.getConfig().groupCheckUrl || '';
        url += `&$filter=id eq '${this.userOid}'`;
        let found = false;
        for (let c = 0; c < numGrps; c += 1) {
            const grpUrl = url.replace('{groupOid}', grpIds[c]);
            logger.debug(`isInGroups-URL- ${grpUrl}`);
            // eslint-disable-next-line no-await-in-loop
            found = await fetch(grpUrl, {
                headers: {
                    Authorization: `Bearer ${appAt}`
                }
            }).then((d) => d.json()).then((d1) => {
                if (d1.error) {
                    // When user does not have access to group an error is also returned
                    logger.debug(`Error while getting member info ${JSON.stringify(d1)}`);
                }
                return d1?.value?.length && true;
            }).catch((err) => {
                logger.warn(err);
                return false;
            });
            if (found) break;
        }
        return found === true;
    }
}

module.exports = GrayboxUser;
