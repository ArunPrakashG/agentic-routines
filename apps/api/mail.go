package main

import (
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/smtp"
	"strings"
	"time"
)

// mailer sends the one kind of mail this service sends: the code that proves a person controls an address.
// It speaks SMTP with STARTTLS (port 587 or 25). Without SMTP_ADDR there is no mailer, and password sign-in is off.
type mailer struct{ addr, user, pass, from string }

func newMailer(c config) *mailer {
	if c.SMTPAddr == "" {
		return nil
	}
	return &mailer{c.SMTPAddr, c.SMTPUser, c.SMTPPass, c.MailFrom}
}

// send delivers a plain text message. to and the subject are ours or already checked, and a line break in either is refused.
func (m *mailer) send(to, subject, body string) error {
	if strings.ContainsAny(to+subject+m.from, "\r\n") {
		return errors.New("bad header")
	}
	host, _, err := net.SplitHostPort(m.addr)
	if err != nil {
		return err
	}
	conn, err := net.DialTimeout("tcp", m.addr, 5*time.Second)
	if err != nil {
		return err
	}
	conn.SetDeadline(time.Now().Add(15 * time.Second))
	c, err := smtp.NewClient(conn, host)
	if err != nil {
		conn.Close()
		return err
	}
	defer c.Close()
	if ok, _ := c.Extension("STARTTLS"); ok {
		if err := c.StartTLS(&tls.Config{ServerName: host, MinVersion: tls.VersionTLS12}); err != nil {
			return err
		}
	}
	if m.user != "" {
		// PlainAuth refuses to send the password over a connection that is not encrypted, except to this machine.
		if err := c.Auth(smtp.PlainAuth("", m.user, m.pass, host)); err != nil {
			return err
		}
	}
	if err := c.Mail(m.from); err != nil {
		return err
	}
	if err := c.Rcpt(to); err != nil {
		return err
	}
	w, err := c.Data()
	if err != nil {
		return err
	}
	msg := fmt.Sprintf("From: %s\r\nTo: %s\r\nSubject: %s\r\nDate: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s\r\n",
		m.from, to, subject, time.Now().UTC().Format(time.RFC1123Z), strings.ReplaceAll(body, "\n", "\r\n"))
	if _, err := w.Write([]byte(msg)); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	return c.Quit()
}
