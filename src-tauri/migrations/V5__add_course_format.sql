-- Generation format chosen before the topic is refined.
ALTER TABLE courses ADD COLUMN course_format TEXT NOT NULL DEFAULT 'academic_course';
