const fetch = require('node-fetch')
const queryString = require('querystring')
const { log, logErr } = require('./logger')

const {
  fetchOptions,
  myFetch,

  checkStatus,
} = require('./lib')

const {
  spotifyServer
} = require('./config')

const {
  getPrevious,
  getCurrent,
  getNext
} = require('./queue')

let fetchCurrentlyPlaying
fetchCurrentlyPlaying = (queue, refreshing) => {
  if (refreshing) queue.isRefreshing = false
  if (!queue) return

  const LONG = 5000 // 5s
  const SHORT = 500 // 1s

  const refresh = refreshTime => {
    if (refreshing) {
      queue.isRefreshing = true
      setTimeout(() => fetchCurrentlyPlaying(queue, true), refreshTime)
    }
  }

  const fetchPlayer = () => fetch(
    spotifyServer + '/me/player',
    fetchOptions(queue)
  )
  return myFetch(fetchPlayer, queue).then(checkStatus).then(async resp => {
    const current = getCurrent(queue)
    if (!current) return
    let data

    try {
      data = await resp.json()
    } catch (err) {
      queue.isPlaying = false
      return refresh(LONG)
    }
    if (data.device) queue.deviceId = data.device.id
    if (!data.item) {
      queue.isPlaying = false
      return refresh(LONG)
    }


    // on queue
    if (data.item.id === current.id) {
      // next song
      if (queue.progress > data.progress_ms &&
        data.progress_ms === 0 &&
        !data.is_playing
      ) {
        playNext(queue)
      }

      queue.progress = data.progress_ms
      queue.isPlaying = data.is_playing
      queue.onQueue = true
    } else {
      const wentOffQueue = queue.onQueue
      queue.onQueue = false
      queue.isPlaying = false

      if (wentOffQueue) return
      else return refresh(SHORT)
    }

    Object.values(queue.sockets).forEach(socket => {
      socket.emit('status', {
        progress: queue.progress,
        isPlaying: queue.isPlaying,
      })
    })

    const msLeft = data.item.duration_ms - data.progress_ms
    if (msLeft && msLeft < 2 * LONG) return refresh(SHORT)
    else return refresh(LONG)
  }).catch(err => {
    logErr(err)
    return refresh(LONG)
  })
}

const play = async (queue, options) => {
  const restart = options && options.restart
  const pause = options && options.pause
  const current = getCurrent(queue) || await getNext(queue)

  if (!queue.deviceId) {
    const err = new Error('No device selected.')
    err.clientMessage = 'No device selected'
    err.status = 404
    throw err
  }
  if (restart) queue.progress = 0
  if (!current && !pause) return

  let url = spotifyServer +
    '/me/player/' + (pause ? 'pause' : 'play') 
  if (queue.deviceId) url += '?' + queryString.stringify({
    device_id: queue.deviceId
  })

  const body = pause ? {} : {
    uris: ['spotify:track:' + current.id],
    position_ms: queue.progress,
  }

  return fetch(url, {
    ...fetchOptions(queue),
    method: 'PUT',
    body: pause ? undefined : JSON.stringify(body),
  }).then(checkStatus)
    .catch(async err => {
      let data
      try {
        data = await err.resp.json()
        err.data = data
      } catch (e) {
        logErr(err)
        throw err
      }
      if (err.status === 403) {
        err.clientMessage = data.error.message
      }
      if (err.status === 404) {
        // err.clientMessage = data.error.message
        err.clientMessage = `
          Device not found. Make sure it\'s active by having
          it playing something already when pressing play on the queue.
        `
      } else {
        logErr(err)
      }
      throw err
    })
    .then(resp => {
      Object.values(queue.sockets).forEach(socket => socket.emit('status', {
        track: current,
        isPlaying: !pause,
        progress: restart ? 0 : undefined
      }))
      if (!queue.isRefreshing) {
        queue.isRefreshing = true
        fetchCurrentlyPlaying(queue, true)
      } else fetchCurrentlyPlaying(queue, false)
      return resp
    })
}

const resume = queue => play(queue)
const playNext = async queue => {
  const current = getCurrent(queue)
  const next = await getNext(queue)
  if (!current && !next) return

  return play(queue, {
    pause: current && !next,
    restart: true
  })
}
const playPrevious = queue => {
  if (queue.progress < 3000) getPrevious(queue)
  return play(queue, { restart: true })
}

const pause = queue => play(queue, { pause: true })

module.exports = {
  resume,
  playNext,
  playPrevious,
  pause,
}
