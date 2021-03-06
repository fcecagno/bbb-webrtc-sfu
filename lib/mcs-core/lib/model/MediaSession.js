/**
 * @classdesc
 * Model class for external devices
 */

'use strict'

const C = require('../constants/Constants');
const rid = require('readable-id');
const Kurento = require('../adapters/kurento/kurento');
const Freeswitch = require('../adapters/freeswitch/freeswitch');
const config = require('config');
const kurentoUrl = config.get('kurentoUrl');
const Logger = require('../../../utils/Logger');
const { handleError } = require('../utils/util');
const LOG_PREFIX = "[mcs-media-session]";

module.exports = class MediaSession {
  constructor (
    emitter,
    room,
    type = 'WebRtcEndpoint',
    options = {}
  ) {
    this.id = rid();
    this.room = room;
    this.emitter = emitter;
    this._status = C.STATUS.STOPPED;
    this._type = type;
    this._mediaElement;
    this.subscribedSessions = [];
    this._options = options;
    this._adapter = options.adapter? options.adapter : C.STRING.KURENTO;
    this._name = options.name? options.name : C.STRING.DEFAULT_NAME;
    this._MediaServer = MediaSession.getAdapter(this._adapter);
    this.eventQueue = [];
    this.outboundIceQueue = [];
    this._mediaStateSubscription = false;
    this._iceSubscription = false;
  }

  _dispatchMediaStateEvent (event) {
    event.mediaId = this.id;
    if (!this._mediaStateSubscription) {
      Logger.debug("[mcs-media-session] Media session", this.id, "queuing event", event);
      this.eventQueue.push(event);
    }
    else {
      Logger.trace("[mcs-media-session] Dispatching", event);
      this.emitter.emit(C.EVENT.MEDIA_STATE.MEDIA_EVENT, event);
    }
  }

  _dispatchIceCandidate (event) {
    event.mediaId = this.id;
    if (!this._iceSubscription) {
      Logger.debug("[mcs-media-session] Media session", this.id, "queuing event", event);
      this.outboundIceQueue.push(event);
    }
    else {
      Logger.trace("[mcs-media-session] Dispatching", event);
      this.emitter.emit(C.EVENT.MEDIA_STATE.ICE, event);
    }
  }

  async start () {
    this._status = C.STATUS.STARTING;
    try {
      const client = await this._MediaServer.init();

      this._mediaElement = await this._MediaServer.createMediaElement(this.room, this._type, this._options);

      Logger.info("[mcs-media-session] New media session", this.id, "in room", this.room, "started with media server endpoint", this._mediaElement);

      this._MediaServer.on(C.EVENT.MEDIA_STATE.MEDIA_EVENT+this._mediaElement, this._dispatchMediaStateEvent.bind(this));
      this._MediaServer.on(C.EVENT.MEDIA_STATE.ICE+this._mediaElement, this._dispatchIceCandidate.bind(this));

      this._MediaServer.trackMediaState(this._mediaElement, this._type);

      this._MediaServer.on(C.ERROR.MEDIA_SERVER_OFFLINE, () => {
          let event = {};
          event.state = C.ERROR.MEDIA_SERVER_OFFLINE;
          event.mediaId = this.id;
          this.emitter.emit(C.EVENT.SERVER_STATE, event);
      });

      this._MediaServer.on(C.EVENT.MEDIA_SERVER_ONLINE, () => {
          let event = {};
          event.state = C.EVENT.MEDIA_SERVER_ONLINE;
          event.mediaId = this.id;
          this.emitter.emit(C.EVENT.SERVER_STATE, event);
      });

      return Promise.resolve(this._mediaElement);
    }
    catch (err) {
      err = this._handleError(err);
      return Promise.reject(err);
    }
  }

  async stop () {
    if (this._status === C.STATUS.STARTED) {
      this._status = C.STATUS.STOPPING;
      try {
        await this._MediaServer.stop(this.room, this._type, this._mediaElement);
        this._status = C.STATUS.STOPPED;
        Logger.info("[mcs-media-session] Session", this.id, "stopped with status", this._status);
        this.emitter.emit(C.EVENT.MEDIA_SESSION_STOPPED, this.id);
        return Promise.resolve();
      }
      catch (err) {
        err = this._handleError(err);
        return Promise.reject(err);
      }
    } else {
      return Promise.resolve();
    }
  }

  async connect (sinkId, type = 'ALL') {
    try {
      Logger.info("[mcs-media-session] Connecting " + this._mediaElement + " => " + sinkId);
      await this._MediaServer.connect(this._mediaElement, sinkId, type);
      return Promise.resolve();
    }
    catch (err) {
      err = this._handleError(err);
      return Promise.reject(err);
    }
  }

  async disconnect (sinkId, type = 'ALL') {
    try {
      Logger.info("[mcs-media-session] Dis-connecting " + this._mediaElement + " => " + sinkId);
      await this._MediaServer.disconnect(this._mediaElement, sinkId, type);
      return Promise.resolve();
    }
    catch (err) {
      err = this._handleError(err);
      return Promise.reject(err);
    }
  }

  addMediaEventListener (type, mediaId) {
    this._MediaServer.addMediaEventListener (type, mediaId);
  }

  sessionStarted () {
    if (this._status === C.STATUS.STARTING) {
      this._status = C.STATUS.STARTED;
      Logger.debug("[mcs-media-session] Session", this.id, "successfully started");
    }
  }

  onEvent (eventName) {
    switch (eventName) {
      case C.EVENT.MEDIA_STATE.MEDIA_EVENT:
        this._mediaStateSubscription = true;
        this._flushMediaStateEvents();
        break;
      case C.EVENT.MEDIA_STATE.ICE:
        this._iceSubscription = true;
        this._flushIceEvents();
        break;
      default: Logger.trace("[mcs-media-session] Unknown event subscription", eventName);
    }

  }

  _flushMediaStateEvents () {
    Logger.debug("[mcs-media-session] Flushing session", this.id, "media state queue");

    while (this.eventQueue.length) {
      const event = this.eventQueue.shift();
      Logger.trace("[mcs-media-session] Dispatching", event);
      this.emitter.emit(C.EVENT.MEDIA_STATE.MEDIA_EVENT, event);
    }
  }

  _flushIceEvents () {
    Logger.debug("[mcs-media-session] Flushing session", this.id, "ICE queue");

    while (this.outboundIceQueue.length) {
      const event = this.outboundIceQueue.shift();
      Logger.trace("[mcs-media-session] Dispatching", event);
      this.emitter.emit(C.EVENT.MEDIA_STATE.ICE, event);
    }
  }

  static getAdapter (adapter) {
    let obj = null;

    Logger.info("[mcs-media-session] Session is using the", adapter, "adapter");

    switch (adapter) {
      case C.STRING.KURENTO:
        obj = new Kurento(kurentoUrl);
        break;
      case C.STRING.FREESWITCH:
        obj = new Freeswitch();
        break;
      default: Logger.warn("[mcs-media-session] Invalid adapter", this.adapter); }

    return obj;
  }

  _handleError (error) {
    this._status = C.STATUS.STOPPED;
    return handleError(LOG_PREFIX, error);
  }
}
