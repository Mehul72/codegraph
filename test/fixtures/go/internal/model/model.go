// Package model holds the domain types shared by every other package.
package model

// UserID is the primary key of a user row.
type UserID string

// Audit records who last touched a row and when.
type Audit struct {
	By UserID
	At int64
}

// User is a person with an account.
type User struct {
	Audit
	ID   UserID
	Name string
}

// Label is what the API shows for this user.
func (u *User) Label() string {
	if u.Name == "" {
		return string(u.ID)
	}
	return u.Name
}

// Reader loads users out of storage.
type Reader interface {
	Find(id UserID) (*User, error)
}

// ReadWriter is a Reader that can also persist.
type ReadWriter interface {
	Reader
	Save(u *User) error
}
