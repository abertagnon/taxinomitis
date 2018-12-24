// external dependencies
import * as fs from 'fs';
import * as Express from 'express';
import * as httpstatus from 'http-status';
// local dependencies
import * as auth from './auth';
import * as store from '../db/store';
import * as Types from '../training/training-types';
import * as conversation from '../training/conversation';
import * as visualrec from '../training/visualrecognition';
import * as numbers from '../training/numbers';
import * as base64decode from '../utils/base64decode';
import * as download from '../utils/download';
import * as urls from './urls';
import * as errors from './errors';
import * as headers from './headers';
import loggerSetup from '../utils/logger';


const log = loggerSetup();


function returnConversationWorkspace(classifier: Types.ConversationWorkspace) {
    return {
        classifierid : classifier.workspace_id,
        credentialsid : classifier.credentialsid,
        updated : classifier.updated,
        expiry : classifier.expiry,
        name : classifier.name,
        status : classifier.status,
    };
}
function transformStatus(visualClassifierStatus?: string): string | undefined {
    switch (visualClassifierStatus) {
    case 'training':
        return 'Training';
    case 'ready':
        return 'Available';
    default:
        return visualClassifierStatus;
    }
}
function returnVisualRecognition(classifier: Types.VisualClassifier) {
    return {
        classifierid : classifier.classifierid,
        credentialsid : classifier.credentialsid,
        updated : classifier.created,
        expiry : classifier.expiry,
        name : classifier.name,
        status : transformStatus(classifier.status),
    };
}
function returnNumberClassifier(classifier: Types.NumbersClassifier) {
    classifier.updated = classifier.created;
    return classifier;
}



async function getModels(req: auth.RequestWithProject, res: Express.Response) {
    const classid = req.params.classid;
    const projectid = req.params.projectid;

    let classifiers;
    switch (req.project.type) {
    case 'text':
        classifiers = await store.getConversationWorkspaces(projectid);
        classifiers = await conversation.getClassifierStatuses(classid, classifiers);
        classifiers = classifiers.map(returnConversationWorkspace);
        break;
    case 'images':
        classifiers = await store.getImageClassifiers(projectid);
        classifiers = await visualrec.getClassifierStatuses(classid, classifiers);
        classifiers = classifiers.map(returnVisualRecognition);
        break;
    case 'numbers':
        classifiers = await store.getNumbersClassifiers(projectid);
        classifiers = classifiers.map(returnNumberClassifier);
        break;
    }

    return res.set(headers.NO_CACHE).json(classifiers);
}

async function newModel(req: auth.RequestWithProject, res: Express.Response) {
    switch (req.project.type) {
    case 'text': {
        try {
            const model = await conversation.trainClassifier(req.project);
            return res.status(httpstatus.CREATED).json(returnConversationWorkspace(model));
        }
        catch (err) {
            if (err.message === conversation.ERROR_MESSAGES.INSUFFICIENT_API_KEYS) {
                return res.status(httpstatus.CONFLICT).send({ code : 'MLMOD01', error : err.message });
            }
            else if (err.message === conversation.ERROR_MESSAGES.API_KEY_RATE_LIMIT) {
                return res.status(httpstatus.TOO_MANY_REQUESTS).send({ code : 'MLMOD02', error : err.message });
            }
            else if (err.message === conversation.ERROR_MESSAGES.MODEL_NOT_FOUND) {
                return res.status(httpstatus.NOT_FOUND)
                          .send({ code : 'MLMOD03', error : err.message + ' Please try again' });
            }
            else if (err.statusCode === httpstatus.UNAUTHORIZED) {
                return res.status(httpstatus.CONFLICT)
                        .send({
                            code : 'MLMOD04',
                            error : 'The Watson credentials being used by your class were rejected. ' +
                                    'Please let your teacher or group leader know.',
                        });
            }
            else if (err.message === 'Unexpected response when retrieving service credentials') {
                return res.status(httpstatus.CONFLICT)
                    .send({
                        code : 'MLMOD05',
                        error : 'No Watson credentials have been set up for training text projects. ' +
                                'Please let your teacher or group leader know.',
                    });
            }
            else {
                return errors.unknownError(res, err);
            }
        }
    }
    case 'images': {
        try {
            const model = await visualrec.trainClassifier(req.project);
            return res.status(httpstatus.CREATED).json(returnVisualRecognition(model));
        }
        catch (err) {
            if (err.message === visualrec.ERROR_MESSAGES.INSUFFICIENT_API_KEYS) {
                return res.status(httpstatus.CONFLICT).send({ code : 'MLMOD06', error : err.message });
            }
            else if (err.message === visualrec.ERROR_MESSAGES.API_KEY_RATE_LIMIT) {
                return res.status(httpstatus.TOO_MANY_REQUESTS).send({ code : 'MLMOD07', error : err.message });
            }
            else if (err.message === 'Not enough images to train the classifier' ||
                     err.message === 'Number of images exceeds maximum (10000)' ||
                     err.message.indexOf(') has unsupported file type (') > 0)
            {
                return res.status(httpstatus.BAD_REQUEST).send({ code : 'MLMOD08', error : err.message });
            }
            else if (err.statusCode === httpstatus.UNAUTHORIZED || err.statusCode === httpstatus.FORBIDDEN) {
                return res.status(httpstatus.CONFLICT)
                        .send({
                            code : 'MLMOD09',
                            error : 'The Watson credentials being used by your class were rejected. ' +
                                    'Please let your teacher or group leader know.',
                        });
            }
            else if (err.message === 'Unexpected response when retrieving service credentials') {
                return res.status(httpstatus.CONFLICT)
                    .send({
                        code : 'MLMOD10',
                        error : 'No Watson credentials have been set up for training images projects. ' +
                                'Please let your teacher or group leader know.',
                    });
            }
            else if (err.message.includes('413 Request Entity Too Large')) {
                return res.status(httpstatus.REQUEST_ENTITY_TOO_LARGE)
                    .json({
                        code : 'MLMOD11',
                        error : 'Machine learning server rejected the training request ' +
                                'because the training data was too large',
                    });
            }
            else if (err.message && err.message.startsWith(download.ERRORS.DOWNLOAD_FAIL)) {
                return res.status(httpstatus.CONFLICT)
                        .send({
                            code : 'MLMOD12',
                            error : 'One of your training images could not be downloaded',
                            location : err.location,
                        });
            }
            else {
                return errors.unknownError(res, err);
            }
        }
    }
    case 'numbers': {
        try {
            const model = await numbers.trainClassifier(req.project);
            return res.status(httpstatus.CREATED).json(returnNumberClassifier(model));
        }
        catch (err) {
            return errors.unknownError(res, err);
        }
    }
    }
}


async function deleteModel(req: auth.RequestWithProject, res: Express.Response) {
    const classid = req.params.classid;
    const userid = req.params.studentid;
    const projectid = req.params.projectid;
    const modelid = req.params.modelid;

    try {
        switch (req.project.type) {
        case 'text': {
            const workspace = await store.getConversationWorkspace(projectid, modelid);
            await conversation.deleteClassifier(workspace);
            return res.sendStatus(httpstatus.NO_CONTENT);
        }
        case 'images': {
            const classifier = await store.getImageClassifier(projectid, modelid);
            await visualrec.deleteClassifier(classifier);
            return res.sendStatus(httpstatus.NO_CONTENT);
        }
        case 'numbers': {
            await numbers.deleteClassifier(userid, classid, projectid);
            return res.sendStatus(httpstatus.NO_CONTENT);
        }
        }
    }
    catch (err) {
        return errors.unknownError(res, err);
    }
}


async function testModel(req: Express.Request, res: Express.Response) {
    const classid = req.params.classid;
    const userid = req.params.studentid;
    const projectid = req.params.projectid;
    const modelid = req.params.modelid;
    const type = req.body.type;
    const credsid = req.body.credentialsid;
    const requestTimestamp = new Date();

    try {
        if (type === 'text') {
            const text = req.body.text;
            if (!text || !credsid) {
                return errors.missingData(res);
            }

            const creds = await store.getBluemixCredentialsById(credsid);

            const classes = await conversation.testClassifier(creds, modelid, requestTimestamp, projectid, text);
            return res.json(classes);
        }
        else if (type === 'images') {
            const imageurl = req.body.image;
            const imagedata = req.body.data;

            if (!credsid || (!imageurl && !imagedata)) {
                return errors.missingData(res);
            }

            const creds = await store.getBluemixCredentialsById(credsid);

            let classes: Types.Classification[];
            if (imageurl) {
                classes = await visualrec.testClassifierURL(creds, modelid, requestTimestamp, projectid, imageurl);
            }
            else {
                const imgfile = await base64decode.run(imagedata);
                try {
                    classes = await visualrec.testClassifierFile(creds, modelid, requestTimestamp, projectid, imgfile);
                }
                finally {
                    fs.unlink(imgfile, logError);
                }
            }
            return res.json(classes);
        }
        else if (type === 'numbers') {
            const numberdata = req.body.numbers;
            if (!numberdata || numberdata.length === 0) {
                return errors.missingData(res);
            }

            const classes = await numbers.testClassifier(userid, classid, requestTimestamp, projectid, numberdata);
            return res.json(classes);
        }
        else {
            return errors.missingData(res);
        }
    }
    catch (err) {
        if (err.message === conversation.ERROR_MESSAGES.MODEL_NOT_FOUND) {
            return res.status(httpstatus.NOT_FOUND).send({ error : err.message + ' Refresh the page' });
        }
        if (err.message === 'Unexpected response when retrieving the service credentials') {
            return errors.notFound(res);
        }
        if (type === 'images' && err.statusCode === 400) {
            return res.status(httpstatus.BAD_REQUEST).send({ error : err.message });
        }

        log.error({ err }, 'Test error');
        return errors.unknownError(res, err);
    }
}


function logError(err?: Error) {
    if (err) {
        log.error({ err }, 'Error when deleting image file');
    }
}




export default function registerApis(app: Express.Application) {

    app.get(urls.MODELS,
            auth.authenticate,
            auth.checkValidUser,
            auth.verifyProjectAccess,
            // @ts-ignore
            getModels);

    app.post(urls.MODELS,
             auth.authenticate,
             auth.checkValidUser,
             auth.verifyProjectOwner,
             // @ts-ignore
             newModel);

    app.delete(urls.MODEL,
               auth.authenticate,
               auth.checkValidUser,
               auth.verifyProjectOwnerOrTeacher,
               // @ts-ignore
               deleteModel);

    app.post(urls.MODELTEST,
             auth.authenticate,
             auth.checkValidUser,
             testModel);

}
