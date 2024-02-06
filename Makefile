APP_NAME=strossle-test-pages
APP_VERSION=1.0.0

image:
	docker build -t $(APP_NAME):$(APP_VERSION) .
	@echo "DONE"

run: image
	docker run --name $(APP_NAME) -d -p 80:80 $(APP_NAME):$(APP_VERSION)
	docker ps -f "name=$(APP_NAME)"
	@echo "DONE"

stop:
	docker stop $(APP_NAME)
	@echo "DONE"

.PHONY: clean
clean: stop
	docker rm $(APP_NAME)
	docker rmi $(APP_NAME):$(APP_VERSION)
	@echo "DONE"
