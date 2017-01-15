from __future__ import absolute_import, division, print_function, unicode_literals
import argparse
import re
import sys
import traceback

import eventlet
import socketio

imapclient = eventlet.import_patched('imapclient')

# idle up to 30 minutes
IDLE_MINUTES = 30

sio = socketio.Server()

client_ips = {}

@sio.on('connect')
def connect(sid, environ):
    fw = environ.get('HTTP_X_FORWARDED_FOR')
    ua = environ.get('HTTP_USER_AGENT')
    remote = environ['REMOTE_ADDR']
    client_ips[sid] = fw or remote
    print('connect %s: %s - %s (%r)' % (sid, fw, remote, ua))


@sio.on('disconnect')
def disconnect(sid):
    print('disconnect %s: %s' % (sid, client_ips.get(sid, '?????')))


class IdlerImapClient(object):
    """ Watch new messages in INBOX and post ticket updates
        via socket.io.
    """
    def __init__(self, conn, ):
        self.M = conn

    def idle(self):
        """ watch loop. Exits only on exceptions """
        while True:
            self.M.idle()
            result = self.M.idle_check(IDLE_MINUTES*60)
            if result:
                print('messages seen: %r' % result)
                self.M.idle_done()
                self.dosync()
            else:
                self.M.idle_done()
                self.M.noop()
                print('no new message seen')

    def dosync(self):
        """ handle received messages about tickets """
        messages = self.M.search(['NOT', 'DELETED'])
        response = self.M.fetch(messages, [b'BODY[HEADER]'])
        for msgid, data in response.items():
            rsu = r'^Subject: \[ jEdit-devel \] \[jedit:([^\]]+)\] #(\d+) '
            subject = data[b'BODY[HEADER]'].decode('utf-8')
            m = re.search(rsu, subject, re.MULTILINE)
            if m:
                tracker = m.group(1)
                number = m.group(2)
                print('update on ticket: %s - %s' % (tracker, number))
                if self.update_ticket(tracker, number):
                    print('Deleting %s' % m.group(0))
                    self.M.delete_messages(msgid)

    def update_ticket(self, tracker, number):
        """ send one ticket update via socket.io """
        data = {'tracker': tracker, 'number': number}
        print("EMITTING %r" % data)
        sio.emit('ticket', data)
        return True


def imap_thread(M):
    """ imap monitoring in background """
    try:
        idler = IdlerImapClient(M)
        idler.dosync()
        idler.idle()
    except:
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)


def init_websocket(M):
    """ create socket.io server and launch imap monitoring """
    app = socketio.Middleware(sio)
    sio.start_background_task(imap_thread, M)
    eventlet.wsgi.server(eventlet.listen(('127.0.0.1', 8000)), app)
    print("OUT OF SERVER") # never reached


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='jEdit trackers mail monitor.')
    parser.add_argument('-s', '--server', required=True,
                        help='imap server')
    parser.add_argument('--port', type=int, default=993,
                        help='imap server port')
    parser.add_argument('-u', '--user', required=True,
                        help='mail user')
    parser.add_argument('-p', '--password', required=True,
                        help='mail user password')

    args = parser.parse_args()

    M = imapclient.IMAPClient(args.server,
                              args.port,
                              use_uid=True, ssl=True)
    M.login(args.user, args.password)
    M.select_folder('INBOX')
    init_websocket(M)
    M.logout()
