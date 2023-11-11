#include <iostream>
#include <crow.h>

int main() {
    crow::SimpleApp app;

    CROW_ROUTE(app, "/")([](){
        auto page = crow::mustache::load_text("main.html");
        return page;
    });

    app.bindaddr("127.0.0.22").port(18080).multithreaded().run();
    return 0;
}