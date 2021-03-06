'use strict';

import EventEmitter from 'events';
import PanZoom from 'util/panzoom.js';

import Board, {
  FOCUS_TILE_COLOR,
  MOVE_TILE_COLOR,
  ATTACK_TILE_COLOR,
} from 'tactics/Board.js';

import unitDataMap, { unitTypeToIdMap } from 'tactics/unitData.js';

export default class {
  /*
   * Arguments:
   *  state: An object supporting the Game class interface.
   */
  constructor(state) {
    if (!state)
      throw new TypeError('Required game state');

    let renderer = PIXI.autoDetectRenderer(Tactics.width, Tactics.height);

    // Let's not go crazy with the move events.
    renderer.plugins.interaction.moveWhenInside = true;

    let board = new Board();
    board.initCard();
    board
      .on('focus', event => {
        Tactics.sounds.focus.play();
        this.focused = event.unit;
      })
      .on('blur', event => {
        this.focused = null;
      })
      .on('select', event => {
        let unit = event.unit;

        Tactics.sounds.select.play();
        if (this.canSelect(unit))
          this.selected = unit;
        else
          this.viewed = unit;
      })
      .on('deselect', () => {
        if (this.viewed)
          this.viewed = null;
        else if (this.selected && !this.state.actions.length && this._selectMode !== 'target')
          this.selected = null;
      })
      // 'move' and 'attack' events do not yet come from the board.
      .on('move',    event => this._postAction(event))
      .on('attack',  event => this._postAction(event))
      .on('turn',    event => this._postAction(event))
      .on('endTurn', event => this._postAction(event))
      .on('card-change', event => this._emit(event))
      .on('lock-change', event => this._emit(event));

    Object.assign(this, {
      // Crude tracking of the pointer type being used.  Ideally, this should
      // reflect the last pointer type to fire an event on the board.
      pointerType: 'ontouchstart' in window ? 'touch' : 'mouse',

      state:            state,
      _stateEventStack: null,

      _teams: [],
      _localTeamIds: [],

      _renderer: renderer,
      _rendering: false,
      _canvas: renderer.view,
      _stage: new PIXI.Container(),
      _animators: {},

      _selectMode: 'move',
      _tranformToRestore: null,

      _notice: null,
      _board: board,

      _panzoom: PanZoom({
        target: renderer.view,
        locked: true,
      }),

      _emitter:    new EventEmitter(),
    });

    Tactics.game = this;

    state.whenReady.then(() => {
      if (state.started)
        this._load();
      else
        state.once('startGame', () => this._load());
    });
  }

  /*****************************************************************************
   * Public Properties
   ****************************************************************************/
  get card() {
    return this._board.card;
  }
  get canvas() {
    return this._canvas;
  }

  get stage() {
    return this._stage;
  }
  get board() {
    return this._board;
  }
  get panzoom() {
    return this._panzoom;
  }

  get focused() {
    return this._board.focused;
  }
  set focused(focused) {
    let board       = this._board;
    let old_focused = board.focused;

    if (focused !== old_focused) {
      if (old_focused)
        old_focused.blur();

      if (focused) {
        let viewOnly = !this.canSelect(focused);
        board.focused = focused.focus(viewOnly);
      }
      else
        board.focused = null;

      this.drawCard();
      this.render();
    }

    return this;
  }

  get selected() {
    return this._board.selected;
  }
  set selected(selected) {
    let board        = this._board;
    let old_selected = board.selected;
    let old_viewed   = board.viewed;

    if (selected !== old_selected) {
      if (old_viewed) {
        board.hideMode();
        old_viewed.deactivate();
        board.viewed = null;
      }

      if (old_selected) {
        board.clearMode();
        old_selected.deactivate();
        board.selected = null;
      }

      if (selected) {
        board.selected = selected;
        this.selectMode = this._pickSelectMode();
      }
      else
        this.selectMode = 'move';

      this.drawCard();
    }
    else if (old_viewed) {
      board.hideMode();
      old_viewed.deactivate();
      board.viewed = null;

      if (selected)
        this.selectMode = selected.activated;
      else
        this.selectMode = 'move';

      this.drawCard();
    }

    return this;
  }

  get viewed() {
    return this._board.viewed;
  }
  set viewed(viewed) {
    let board      = this._board;
    let old_viewed = board.viewed;

    if (viewed !== old_viewed) {
      if (old_viewed) {
        board.hideMode();
        old_viewed.deactivate();
        board.viewed = null;
      }

      let selected = board.selected;

      if (viewed) {
        board.viewed = viewed;
        this.selectMode = this._pickSelectMode();
      }
      else
        this.selectMode = selected ? selected.activated : 'move';

      this.drawCard();
    }

    return this;
  }

  get selectMode() {
    return this._selectMode;
  }
  set selectMode(selectMode) {
    /*
     * Note: No attempt is made to see if the provided selectMode is the same as
     * the current selectMode.  Certain actions need to be taken when a select
     * mode is assigned, even if it is the same.
     */

    /*
     * Reset temporary zoom, if one was made.
     */
    let transformToRestore = this.transformToRestore;
    if (transformToRestore) {
      this._panzoom.transitionToTransform(transformToRestore);
      this.transformToRestore = null;
    }

    let board    = this._board;
    let viewed   = board.viewed;
    let selected = board.selected;

    if (viewed)
      viewed.activate(selectMode, true);
    else if (selected)
      selected.activate(selectMode);

    this._emit({
      type:   'selectMode-change',
      ovalue: this._selectMode,
      nvalue: selectMode,
    });

    this._selectMode = selectMode;
    board.showMode();
    this.render();

    return this;
  }

  get notice() {
    return this._notice;
  }
  set notice(notice) {
    clearTimeout(this._noticeTimeout);
    if (notice === this._notice) return;

    this._notice = notice;
    this.drawCard();

    return this._notice;
  }

  get teams() {
    return this._teams;
  }
  get activeTeams() {
    return this._teams.filter(team => !!team.units.length);
  }
  get currentTeam() {
    return this._teams[this.state.currentTeamId];
  }
  get isLocalGame() {
    return this._localTeamIds.length === this.state.teams.length;
  }
  get hasOneLocalTeam() {
    return this._localTeamIds.length === 1;
  }

  get actions() {
    return this._board.decodeAction(this.state.actions);
  }
  get moved() {
    return !!this.state.actions
      .find(a => a.type === 'move');
  }
  get attacked() {
    return !!this.state.actions
      .find(a => a.type === 'attack' || a.type === 'attackSpecial');
  }

  /*****************************************************************************
   * Public Methods
   ****************************************************************************/
  join(team, slot) {
    if (!slot)
      slot = this.state.teams.findIndex(t => !t);

    if (!team.bot)
      this._localTeamIds.push(slot);

    return this.state.join(team, slot);
  }
  isMyTeam(team) {
    if (team === undefined)
      throw new TypeError('Required team argument');

    if (typeof team === 'number')
      team = this.teams[team];

    return this._localTeamIds.includes(team.originalId);
  }

  /*
   * Used to start playing the game... even if it is from the middle of it.
   */
  start() {
    let state = this.state;

    return new Promise((resolve, reject) => {
      // Let the caller finish what they are doing.
      setTimeout(() => {
        // Clone teams since board.setState() applies a units property to each.
        this._teams = state.teams.map(team => ({...team}));

        this._onStateEventListener = this._onStateEvent.bind(this);

        state
          .on('startTurn', this._onStateEventListener)
          .on('action', this._onStateEventListener)
          .on('reset', this._onStateEventListener)
          .on('undo', this._onStateEventListener)
          .on('endGame', this._onStateEventListener);

        this._stateEventStack = this._replay()
          .then(() => this._startTurn(this.state.currentTeamId));

        resolve();
      }, 100); // A "zero" delay is sometimes not long enough
    });
  }
  /*
   * This is used when surrendering serverless games.
   */
  restart() {
    this.lock();

    let state = this.state;

    // Reset controlled teams.
    if (state.type === 'Chaos')
      this._localTeamIds.length = 1;

    if (this._onStateEventListener)
      state
        .off('startTurn', this._onStateEventListener)
        .off('action', this._onStateEventListener)
        .off('reset', this._onStateEventListener)
        .off('undo', this._onStateEventListener)
        .off('endGame', this._onStateEventListener)

    this.notice = null;

    // Inform game state to restart.
    state.restart();

    return this.start();
  }

  /*
   * Allow touch devices to upscale to normal size.
   */
  resize() {
    let canvas = this._canvas;
    canvas.style.width  = null;
    canvas.style.height = null;

    let container = canvas.parentNode;
    let width     = container.clientWidth;
    let height    = container.clientHeight;

    if (window.innerHeight < height) {
      let rect = canvas.getBoundingClientRect();

      height  = window.innerHeight;
      height -= rect.top;
      //height -= window.innerHeight - rect.bottom;
      //console.log(window.innerHeight, rect.bottom);
    }
    else
      height -= canvas.offsetTop;

    let width_ratio  = width  / Tactics.width;
    let height_ratio = height / Tactics.height;
    let elementScale = Math.min(1, width_ratio, height_ratio);

    if (elementScale < 1)
      if (width_ratio < height_ratio)
        canvas.style.width = '100%';
      else
        canvas.style.height = height+'px';

    let panzoom = this._panzoom;
    panzoom.maxScale = 1 / elementScale;
    panzoom.reset();

    return self;
  }

  /*
   * Most games have a "render loop" that refreshes all display objects on the
   * stage every time the screen refreshes - about 60 frames per second.  The
   * animations in this game runs at about 12 frames per second and do not run
   * at all times.  To improve battery life on mobile devices, it is better to
   * only render when needed.  Only two things may cause the stage to change:
   *   1) An animation is being run.
   *   2) The user interacted with the game.
   *
   * So, call this method once per animation frame or once after handling a
   * user interaction event.  If this causes the render method to be called
   * more frequently than the screen refresh rate (which is very possible
   * just by whipping around the mouse over the game board), then the calls
   * will be throttled thanks to requestAnimationFrame().
   */
  render() {
    if (this._rendering) return;
    this._rendering = true;

    requestAnimationFrame(this._render.bind(this));
  }
  /*
   * This clever function will call your animator every throttle millseconds
   * and render the result.  The animator must return false when the animation
   * is complete.  The animator is passed the number of frames that should be
   * skipped to maintain speed.
   */
  renderAnim(anim, fps) {
    let throttle = 1000 / fps;
    let animators = [anim];
    let start;
    let delay = 0;
    let count = 0;
    let skip = 0;
    let i;

    let loop = now => {
      skip = 0;

      // stop the loop if all animators returned false
      if (animators.length) {
        if (count) {
          delay = (now - start) - (count * throttle);

          if (delay > throttle) {
            skip = Math.floor(delay / throttle);
            count += skip;

            requestAnimationFrame(loop);
          }
          else {
            setTimeout(() => requestAnimationFrame(loop), throttle - delay);
          }
        }
        else {
          start = now;
          setTimeout(() => requestAnimationFrame(loop), throttle);
        }

        // Iterate backward since elements may be removed.
        for (i = animators.length-1; i > -1; i--) {
          if (animators[i](skip) === false)
            animators.splice(i, 1);
        }
        this.render();
        count++;
      }
      else {
        delete this._animators[fps];
      }
    };

    // Stack multiple animations using the same FPS into one loop.
    if (fps in this._animators)
      this._animators[fps].push(anim);
    else {
      this._animators[fps] = animators;
      requestAnimationFrame(loop);
    }
  }

  /*
   * Can a unit be selected?  If not, then it can only be viewed.
   */
  canSelect(unit) {
    let selected = this.selected;
    if (selected && selected !== unit && this.state.actions.length)
      return false;

    return unit.team === this.currentTeam && !unit.mRecovery && !unit.paralyzed;
  }

  /*
   * Can a select mode be selected for the currently viewed or selected unit?
   */
  canSelectMove() {
    let viewed = this.viewed;
    if (viewed)
      return !!viewed.getMoveTiles().length;

    let selected = this.selected;
    if (selected)
      return !this.moved && selected.getMoveTiles().length;

    return true;
  }
  canSelectAttack() {
    let viewed = this.viewed;
    if (viewed)
      return !!viewed.getAttackTiles().length;

    let selected = this.selected;
    if (selected)
      return !this.attacked && selected.getAttackTiles().length;

    return true;
  }
  canSelectSpecial() {
    let selected = this.selected;
    if (selected)
      return selected.canSpecial();

    return false;
  }
  canSelectTurn() {
    let unit = this.viewed || this.selected;
    if (unit)
      return unit.directional !== false;

    return true;
  }

  /*
   * Animate the unit getting ready to launch their special attack.
   * Returns a promise decorated with a couple of useful methods.
   */
  readySpecial() {
    let anim = this.selected.animReadySpecial();
    let promise = anim.play();

    // If you release too early, the attack is cancelled.
    // If you release after ~2 secs then the attack is launched. 
    promise.release = () => {
      anim.stop();
      if (anim.state.ready)
        this._postAction({type:'attackSpecial'});
    };

    // For the sake of all that's holy, don't attack even if ready!
    promise.cancel = () => anim.stop();

    return promise;
  }

  pass() {
    this._postAction({type:'endTurn'});
  }

  canUndo() {
    let state   = this.state;
    let teams   = this._teams;
    let actions = this.actions;

    if (this.isLocalGame)
      // Allow unrestricted undo when all teams are local.
      return !!actions.length || !!state.currentTurnId;
    else if (this.isMyTeam(state.currentTeamId)) {
      if (actions.length === 0) return false;

      let unitId = actions[0].unit;
      let lastLuckyActionIndex = actions.findLastIndex(action =>
        // Counter-attacks can't be undone.
        action.unit !== unitId ||
        // Luck-involved attacks can't be undone.
        action.results && !!action.results.find(result => 'luck' in result)
      );

      return lastLuckyActionIndex < (actions.length - 1);
    }

    return false;
  }
  undo() {
    this.selected = null;

    this.lock();
    this.state.undo();
  }

  rotateBoard(rotation) {
    this._board.rotate(rotation);
    this.render();
  }

  zoomToTurnOptions() {
    let selected = this.selected;
    if (!selected) return;

    let panzoom = this._panzoom;

    this.transformToRestore = panzoom.transform;

    // Get the absolute position of the turn options.
    let point = selected.assignment.getTop().clone();
    point.y -= 14;

    // Convert coordinates to percentages.
    point.x = point.x / Tactics.width;
    point.y = point.y / Tactics.height;

    panzoom.transitionPointToCenter(point, panzoom.maxScale);

    return this;
  }

  delayNotice(notice) {
    let delay = 200;

    this.notice = null;
    this._noticeTimeout = setTimeout(() => {
      this.notice = notice;
    }, delay);
  }

  drawCard(unit) {
    this._board.drawCard(unit, this._notice);
    return this;
  }
  lock(lockMode) {
    this._board.lock(lockMode);
    return this;
  }
  unlock() {
    this._board.unlock();
    return this;
  }

  on() {
    this._emitter.addListener(...arguments);
    return this;
  }
  off() {
    this._emitter.removeListener(...arguments);
    return this;
  }

  /*****************************************************************************
   * Private Methods
   ****************************************************************************/
  _load() {
    let resources = [];
    let loaded = 0;
    let loader = PIXI.loader;
    let loadedUnitTypes = [];
    let effects = {};

    let progress = () => {
      let percent = (++loaded / resources.length) * 100;

      if (percent === 100) {
        this._board.draw(this._stage);

        this._emit({ type:'ready' });
      }

      this._emit({
        type: 'progress',
        percent: percent,
      });
    };

    Tactics.images.forEach(image_url => {
      let url = 'https://legacy.taorankings.com/images/'+image_url;

      resources.push(url);
      loader.add({ url:url });
    });

    Object.keys(Tactics.sounds).forEach(name => {
      let sound = Tactics.sounds[name];
      if (typeof sound === 'string')
        sound = {file: sound};

      let url = 'https://tactics.taorankings.com/sounds/'+sound.file;

      Tactics.sounds[name] = new Howl({
        src:        [url+'.mp3', url+'.ogg'],
        sprite:      sound.sprite,
        volume:      sound.volume || 1,
        rate:        sound.rate || 1,
        onload:      () => progress(),
        onloaderror: () => {},
      });

      resources.push(url);
    });

    Object.keys(Tactics.effects).forEach(name => {
      let effect_url = Tactics.effects[name].frames_url;

      if (!(effect_url in effects)) {
        resources.push(effect_url);

        effects[effect_url] = $.getJSON(effect_url).then(renderData => {
          progress();
          return renderData;
        });
      }
  
      effects[effect_url].then(renderData => {
        Object.assign(Tactics.effects[name], renderData);
        return renderData;
      });
    });

    let trophy_url = unitDataMap.get('Champion').frames_url;
    resources.push(trophy_url);

    $.getJSON(trophy_url).then(renderData => {
      Object.assign(unitDataMap.get('Champion'), renderData);
      progress();
    });

    this.state.teams.forEach(team => {
      let teamUnits = team.set.slice();

      // The Chaos Dragon is not yet a member of a team, but must be loaded.
      if (team.name === 'Chaos')
        teamUnits.push({type:'ChaosDragon'});

      teamUnits.forEach(({type:unitType}) => {
        let unitData   = unitDataMap.get(unitType);
        let unitTypeId = unitTypeToIdMap.get(unitType);
        let sprites    = [];

        if (loadedUnitTypes.includes(unitTypeId))
          return;
        loadedUnitTypes.push(unitTypeId);

        if (unitData.sounds) {
          Object.keys(unitData.sounds).forEach(name => {
            let sound = unitData.sounds[name];
            if (typeof sound === 'string')
              sound = {file: sound};

            let url = 'https://tactics.taorankings.com/sounds/'+sound.file;

            unitData.sounds[name] = new Howl({
              src:         [url+'.mp3', url+'.ogg'],
              sprite:      sound.sprite,
              volume:      sound.volume || 1,
              rate:        sound.rate || 1,
              onload:      () => progress(),
              onloaderror: () => {},
            });

            resources.push(url);
          });
        }

        if (unitData.effects) {
          Object.keys(unitData.effects).forEach(name => {
            let effect_url = unitData.effects[name].frames_url;

            if (!(effect_url in effects)) {
              resources.push(effect_url);

              effects[effect_url] = $.getJSON(effect_url).then(renderData => {
                progress();
                return renderData;
              });
            }
  
            effects[effect_url].then(renderData => {
              Object.assign(unitData.effects[name], renderData);
              return renderData;
            });
          });
        }

        if (unitData.frames_url) {
          let frames_url = unitData.frames_url;
          resources.push(frames_url);

          $.getJSON(frames_url).then(renderData => {
            Object.assign(unitData, renderData);

            // Preload data URIs.
            renderData.images.forEach(image_url => {
              PIXI.BaseTexture.from(image_url);
            });

            progress();
          });
        }
        // Legacy
        else if (unitData.frames) {
          unitData.frames.forEach(frame => {
            if (!frame) return;

            frame.c.forEach(sprite => {
              let url = 'https://legacy.taorankings.com/units/'+unitTypeId+'/image'+sprite.id+'.png';
              if (resources.includes(url))
                return;

              resources.push(url);
              loader.add({ url:url });
            });
          });
        }
        // Legacy
        else {
          sprites.push.apply(sprites, Object.values(unitData.stills));

          if (unitData.walks)
            sprites.push.apply(sprites, [].concat.apply([], Object.values(unitData.walks)));

          if (unitData.attacks)
            sprites.push.apply(sprites, [].concat.apply([], Object.values(unitData.attacks)));

          if (unitData.blocks)
            sprites.push.apply(sprites, [].concat.apply([], Object.values(unitData.blocks)));

          sprites.forEach(sprite => {
            Object.keys(sprite).forEach(name => {
              let image = sprite[name];
              if (!image.src) return;

              let url = 'https://legacy.taorankings.com/units/'+unitTypeId+'/'+name+'/image'+image.src+'.png';
              if (resources.includes(url))
                return;

              resources.push(url);
              loader.add({ url:url });
            });
          });
        }
      });
    });

    loader
      .on('progress', progress)
      .load();

    return this;
  }
  _reset(turnData) {
    this.selected = this.viewed = null;

    this._board.setState(turnData.units, this._teams);
    this._startTurn(this.state.currentTeamId);

    let actions = this.actions;
    if (actions.length)
      this.selected = actions[0].unit;
  }

  /*
   * Initiate an action, whether it be moving, attacking, turning, or passing.
   */
  _postAction(action) {
    if (action.type !== 'endTurn')
      action.unit = this.selected;

    this.selected = null;
    this.delayNotice('Sending order...');

    this.lock();
    this.state.postAction(this._board.encodeAction(action));
  }
  _performActions(actions) {
    // The actions array can be empty due to the _replay() method.
    if (actions.length === 0) return Promise.resolve();

    let board = this._board;
    actions = board.decodeAction(actions);

    this.notice = null;

    let painted = [];
    let selected;
    let promise = actions.reduce(
      (promise, action) => promise.then(() => {
        // Actions initiated by local players get a short performance.
        if (this.isMyTeam(action.teamId))
          return this._performAction(action);

        if (action.type === 'endTurn') {
          painted.forEach(tile => tile.strip());

          return this._performAction(action);
        }

        return new Promise(resolve => {
          // Show the player the unit that is about to act.
          if (!selected) {
            selected = action.unit;

            painted.push(
              selected.assignment.paint('focus', 0.3, FOCUS_TILE_COLOR)
            );
          }

          let actionType = action.type;

          if (actionType === 'move') {
            // Show the player where the unit will move.
            painted.push(
              action.assignment.paint('move', 0.3, MOVE_TILE_COLOR)
            );

            selected.activate();
            this.drawCard(selected);

            // Wait 2 seconds then move.
            setTimeout(() => {
              selected.deactivate();
              this._performAction(action).then(resolve);
            }, 2000);
          }
          else if (actionType === 'attack') {
            // For counter-attacks, the attacker may differ from selected.
            let attacker = action.unit;

            // Show the player the units that will be attacked.
            let target = action.target;
            let target_units = attacker.getTargetUnits(target);

            if (target_units.length) {
              target_units.forEach(tu => {
                tu.activate();
                painted.push(
                  tu.assignment.paint('attack', 0.3, ATTACK_TILE_COLOR)
                );
              });

              if (target_units.length === 1) {
                attacker.setTargetNotice(target_units[0], target);
                this.drawCard(target_units[0]);
              }
              else
                this.drawCard(attacker);
            }
            else
              target.paint('attack', 0.3, ATTACK_TILE_COLOR);

            attacker.activate();

            // Wait 2 seconds then attack.
            setTimeout(() => {
              target_units.forEach(tu => {
                tu.deactivate();
                tu.notice = null;
              });

              attacker.deactivate();
              this._performAction(action).then(resolve);
            }, 2000);
          }
          else if (actionType === 'turn') {
            // Show the direction the unit turned for 2 seconds.
            this._performAction(action).then(() => {
              board.showDirection(selected);
              selected.activate();
            });

            setTimeout(() => {
              selected.deactivate();
              board.hideTurnOptions();
              resolve();
            }, 2000);
          }
          // Only applicable to Chaos Seed/Dragon
          else if (actionType === 'phase') {
            // Show the user the egg for 1 second before changing color
            this.drawCard(action.unit);

            // Changing color takes about 1 second.
            setTimeout(() => this._performAction(action), 1000);

            // Show the user the new color for 1 second.
            setTimeout(resolve, 3000);
          }
          // Only applicable to Chaos Seed counter-attack
          else if (actionType === 'heal') {
            // Show the player the unit that will be healed.
            let target_unit = action.target.assigned;
            target_unit.activate();
            this.drawCard(target_unit);

            // Wait 1 second then attack.
            setTimeout(() => {
              target_unit.deactivate();

              this._performAction(action).then(resolve);
            }, 1000);
          }
          else {
            let attacker = action.unit;

            this.drawCard(attacker);
            attacker.activate();

            // Wait 2 seconds then do it.
            setTimeout(() => {
              attacker.deactivate();
              this._performAction(action).then(resolve);
            }, 2000);
          }
        });
      }),
      Promise.resolve(),
    );

    promise.then(() => {
      painted.forEach(tile => tile.strip());
    });

    // If the action didn't result in ending the turn, then set mode.
    let lastAction = actions[actions.length-1];
    if (lastAction.type !== 'endTurn' && this.isMyTeam(lastAction.teamId))
      promise = promise.then(() => {
        this.unlock();
        this.selected = actions[0].unit;
      });

    return promise;
  }
  // Act out the action on the board.
  _performAction(action) {
    if (action.type === 'endTurn')
      return this._endTurn(action);

    let unit = action.unit;

    return unit[action.type](action)
      .then(() => this._playResults(action.results));
  }
  /*
   * Show the player the results of an attack
   */
  _playResults(results) {
    if (!results)
      return;
    if (!Array.isArray(results))
      results = [results];

    let showResult = result => {
      let anim = new Tactics.Animation();
      let changes = Object.assign({}, result.changes);

      // Changed separately
      let mHealth = changes.mHealth;
      delete changes.mHealth;

      let unit = result.unit;
      if (changes.type) {
        // The unit actually refers to the old unit object.
        // Find the new unit object, which should have the same ID.
        unit = unit.team.units.find(u => u.id === unit.id);
        delete changes.type;
      }

      // This can happen when the Chaos Seed hatches and consumes the unit.
      if (!unit.assignment) return;

      this.drawCard(unit);

      if (Object.keys(changes).length)
        unit.change(changes);
      if (result.results)
        this._applyChangeResults(result.results);

      anim.splice(this._animApplyFocusChanges(result));

      if (result.miss) {
        unit.change({notice: 'Miss!'});
        let caption = result.notice || 'Miss!';
        return unit.animCaption(caption).play();
      }

      if ('focusing' in changes) {
        let caption = result.notice;
        if (caption)
          anim.splice(0, unit.animCaption(caption));

        return anim.play();
      }

      if (changes.paralyzed) {
        let caption = result.notice || 'Paralyzed!';
        anim.splice(0, unit.animCaption(caption));

        return anim.play();
      }

      if (changes.poisoned) {
        let caption = result.notice || 'Poisoned!';
        anim.splice(0, unit.animCaption(caption));

        return anim.play();
      }

      // Only animate health loss and death if unit is still on the board.
      // A knight consumed by hatched Chaos Dragon would not still be on the board.
      if (mHealth !== undefined && unit.assignment) {
        let increment;
        let options = {};

        if (mHealth > unit.mHealth)
          options.color = '#00FF00';
        else if (mHealth < unit.mHealth && mHealth !== -unit.health)
          options.color = '#FFBB44';

        let diff = unit.mHealth - mHealth;

        // Die if the unit is dead and isn't a hatching Chaos Seed
        if (mHealth === -unit.health && unit.name !== 'Chaos Seed' && unit.assignment) {
          let caption = result.notice || 'Nooo...';
          anim
            .splice(0, unit.animCaption(caption, options))
            .splice(unit.animDeath());
        }
        else {
          let caption = result.notice || Math.abs(diff).toString();
          anim.splice(0, unit.animCaption(caption, options));
        }

        // Animate a change in health over 1 second (12 frames)
        if (mHealth !== unit.mHealth) {
          let progress = unit.mHealth;

          anim.splice(0, [
            {
              script: () => {
                if (Math.abs(diff) < 8) {
                  progress += (diff / Math.abs(diff)) * -1;
                  if (diff < 0)
                    progress = Math.min(mHealth, progress);
                  else
                    progress = Math.max(mHealth, progress);
                }
                else
                  progress += (diff / 8) * -1;

                unit.change({
                  mHealth: Math.round(progress),
                });
              },
              repeat: 8,
            },
            // Pause to reflect upon the new health amount
            {
              script: () => {},
              repeat: 4,
            },
          ]);
        }

        return anim.play();
      }
    };

    return results.reduce(
      (promise, result) => promise
        .then(() => showResult(result))
        .then(() => {
          let unit = result.unit;
          if (unit) unit.change({notice: null});
        }),
      Promise.resolve(),
    ).then(() => this.drawCard());
  }

  _render() {
    let renderer = this._renderer;

    this._board.sortUnits();

    // This is a hammer.  Without it, the mouse cursor will not change to a
    // pointer and back when needed without moving the mouse.
    renderer.plugins.interaction.update();

    renderer.render(this._stage);
    this._rendering = false;
  }

  /*
   * Play back all activity leading up to this point.
   */
  _replay() {
    let board = this._board;
    let state = this.state;
    let teams = this._teams;
    let currentTurnId = state.currentTurnId;
    let currentTurnActions = this.state.actions;

    // Start with this turnId
    let turnId = Math.max(0, currentTurnId - (teams.length-1));

    let replayActions = actions =>
      this._performActions(actions).then(() => {
        turnId++;

        if (turnId > currentTurnId)
          return;
        else if (turnId === currentTurnId)
          return replayActions(currentTurnActions);
        else
          return state.getTurnActions(turnId).then(replayActions);
      });

    return state.getTurnData(turnId).then(turnData => {
      board.setState(turnData.units, teams);
      this.render();

      return replayActions(turnData.actions);
    });
  }
  _startTurn(teamId) {
    let team = this.teams[teamId];

    if (this.isMyTeam(team)) {
      if (this.hasOneLocalTeam)
        this.notice = 'Your Turn!';
      else
        this.notice = 'Go '+(team.name || team.colorId)+'!';

      this.selectMode = 'move';
      this.unlock();
    }
    else
      this.delayNotice('Waiting for '+(team.name || team.colorId));

    return this;
  }
  _endTurn(action) {
    // Assuming control of a bot team is specific to the chaos game type.
    if (this.state.type === 'Chaos')
      if ('newPlayerTeam' in action) {
        let newPlayerTeam = this.teams[action.newPlayerTeam];
        this._localTeamIds.push(newPlayerTeam.originalId);
      }

    this._applyChangeResults(action.results);

    return this;
  }
  _endGame(winnerId) {
    if (winnerId === null)
      this.notice = 'Draw!';
    else {
      let winner = this._teams[winnerId];
      if (this.isMyTeam(winner) && this.hasOneLocalTeam)
        this.notice = 'You win!';
      else
        this.notice = (winner.name || winner.colorId)+' Wins!';
    }

    this.selected = null;
    this.lock('gameover');

    return this;
  }

  _pickSelectMode() {
    // Pick what a unit can can[].
    let can = [];
    if (this.canSelectMove())
      can.push('move');
    if (this.canSelectAttack())
      can.push('attack');
    if (this.canSelectTurn())
      can.push('turn');
    can.push('direction');

    let selectMode = this.selectMode;
    if (selectMode === null || !can.includes(selectMode))
      selectMode = can.shift();

    return selectMode;
  }

  _applyChangeResults(results) {
    if (!results) return;

    results.forEach(result => {
      let unit    = result.unit;
      let changes = result.changes;

      if (changes) {
        if (changes.direction)
          unit.stand(changes.direction);

        unit.change(result.changes);
      }

      if (result.results)
        this._applyChangeResults(result.results);
    });
  }
  _animApplyFocusChanges(result) {
    let anim       = new Tactics.Animation();
    let unit       = result.unit;
    let hasFocus   = unit.hasFocus();
    let needsFocus = unit.focusing || unit.paralyzed || unit.poisoned;

    if (!hasFocus && needsFocus)
      anim.splice(0, unit.animFocus(0.5));
    else if (hasFocus && !needsFocus)
      anim.splice(0, unit.animDefocus());

    if (result.results)
      result.results.forEach(result => anim.splice(0, this._animApplyFocusChanges(result)));

    return anim;
  }

  /*
   * This method ensures state events are processed synchronously.
   * Otherwise, 'startTurn' or 'endGame' may trigger while performing actions.
   */
  _onStateEvent(event) {
    // Event handlers are expected to either return a promise that resolves when
    // handling is complete or nothing at all.
    let eventHandler;
    if (event.type === 'startTurn')
      eventHandler = () => this._startTurn(event.teamId);
    else if (event.type === 'action')
      eventHandler = () => this._performActions(event.actions);
    else if (event.type === 'reset')
      eventHandler = () => this._reset(event);
    /*
    else if (event.type === 'undo')
      eventHandler = event => {
        // TODO: Prompt user to approve undo request.
      };
    */
    else if (event.type === 'endGame')
      eventHandler = () => this._endGame(event.winnerId);
    else
      throw new Error('Unhandled event: '+event.type);

    this._stateEventStack = this._stateEventStack.then(eventHandler);
  }

  _emit(event) {
    this._emitter.emit(event.type, event);
  }
}
